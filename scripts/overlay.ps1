[CmdletBinding()]
param(
    [Uri]$Server = 'https://localhost:8443',
    [Uri]$Url,
    [ValidateRange(1, 32)][int]$Monitor = 1,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This overlay requires Windows.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.Serialization
$references = @(
    [System.Windows.Forms.Form].Assembly.Location,
    [System.Drawing.Color].Assembly.Location,
    [System.Drawing.Graphics].Assembly.Location,
    [System.Net.WebSockets.ClientWebSocket].Assembly.Location,
    [System.Runtime.Serialization.Json.DataContractJsonSerializer].Assembly.Location,
    [System.Runtime.Serialization.DataContractAttribute].Assembly.Location,
    [System.Xml.XmlReader].Assembly.Location
) | Select-Object -Unique
if ($PSVersionTable.PSEdition -eq 'Core') {
    # PowerShell Core compiles against reference assemblies, plus the Windows desktop assemblies.
    $references = @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName)
    $references += [System.Windows.Forms.Form].Assembly.Location
    $references += [System.Windows.Forms.Message].Assembly.Location
    $references += [System.Drawing.Graphics].Assembly.Location
    $references = $references | Select-Object -Unique
}

if (-not ('LanLaser.Overlay' -as [type])) {
    Add-Type -ReferencedAssemblies $references -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace LanLaser {
    [DataContract]
    public sealed class Message {
        [DataMember(Name = "type")] public string Type;
        [DataMember(Name = "point")] public double[] Point;
        [DataMember(Name = "connected")] public bool Connected;
        [DataMember(Name = "direction")] public string Direction;
    }

    public sealed class Overlay : Form {
        private const int HotkeyId = 19476;
        private const int TrailLifetimeMs = 500;
        private const int MaxTrailPoints = 180;
        private readonly Uri endpoint;
        private readonly Rectangle monitorBounds;
        private readonly CancellationTokenSource stop = new CancellationTokenSource();
        private readonly System.Windows.Forms.Timer staleTimer = new System.Windows.Forms.Timer();
        private readonly List<TrailSample> trail = new List<TrailSample>();
        private ClientWebSocket socket;
        private bool dotVisible;
        private bool frameDirty = true;
        private double x, y;
        private DateTime lastPoint = DateTime.MinValue;
        private IntPtr memoryDc, dib, previousBitmap;
        private Bitmap surface;
        private Graphics surfaceGraphics;

        private sealed class TrailSample {
            public double X, Y;
            public DateTime At;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);
        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll")]
        private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screenDc, ref NativePoint position,
            ref NativeSize size, IntPtr sourceDc, ref NativePoint source, uint colorKey, ref BlendFunction blend, uint flags);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage,
            out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")]
        private static extern bool DeleteDC(IntPtr dc);

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct NativeSize { public int Width, Height; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct BlendFunction { public byte Operation, Flags, ConstantAlpha, AlphaFormat; }
        [StructLayout(LayoutKind.Sequential)]
        private struct BitmapInfo {
            public uint Size;
            public int Width, Height;
            public ushort Planes, BitCount;
            public uint Compression, ImageSize;
            public int XPelsPerMeter, YPelsPerMeter;
            public uint ColorsUsed, ColorsImportant;
        }

        public static IntPtr EnterDpiContext() {
            // Use physical monitor coordinates without changing the host process DPI mode.
            try { return SetThreadDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { return IntPtr.Zero; }
        }

        public static void LeaveDpiContext(IntPtr context) {
            if (context != IntPtr.Zero) SetThreadDpiAwarenessContext(context);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Input { public uint Type; public InputUnion Data; }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion {
            [FieldOffset(0)] public KeyboardInput Keyboard;
            [FieldOffset(0)] public MouseInput Mouse;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput {
            public ushort Key, Scan;
            public uint Flags, Time;
            public UIntPtr Extra;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MouseInput {
            public int X, Y;
            public uint Data, Flags, Time;
            public UIntPtr Extra;
        }

        public Overlay(string url, int monitor) {
            endpoint = new Uri(url);
            if (monitor < 1 || monitor > Screen.AllScreens.Length)
                throw new ArgumentException("Monitor must be between 1 and " + Screen.AllScreens.Length + ".");
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            monitorBounds = Screen.AllScreens[monitor - 1].Bounds;
            Bounds = monitorBounds;
            ShowInTaskbar = false;
            TopMost = true;
            staleTimer.Interval = 16;
            staleTimer.Tick += delegate { Tick(DateTime.UtcNow); };
        }

        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get {
                CreateParams p = base.CreateParams;
                // Layered, transparent, tool-window and no-activate styles preserve slide focus.
                p.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000;
                return p;
            }
        }

        protected override void OnShown(EventArgs e) {
            base.OnShown(e);
            // WinForms may adjust the initial client width while creating its native handle.
            Bounds = monitorBounds;
            RenderLayeredFrame(DateTime.UtcNow);
            if (!RegisterHotKey(Handle, HotkeyId, 0x0001 | 0x0002 | 0x4000, (uint)Keys.Q)) {
                Console.Error.WriteLine("Ctrl+Alt+Q is already registered. Close the other overlay and retry.");
                Close();
                return;
            }
            staleTimer.Start();
            Task.Run((Func<Task>)NetworkLoop);
        }

        protected override void OnHandleCreated(EventArgs e) {
            base.OnHandleCreated(e);
            RenderLayeredFrame(DateTime.UtcNow);
        }

        protected override void WndProc(ref System.Windows.Forms.Message m) {
            if (m.Msg == 0x0312 && m.WParam.ToInt32() == HotkeyId) {
                Close();
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnPaintBackground(PaintEventArgs e) { }
        protected override void OnPaint(PaintEventArgs e) { }

        private static PointF MapPoint(double px, double py, Size size) {
            return new PointF((float)((px + 1) * 0.5 * (size.Width - 20) + 10),
                (float)((py + 1) * 0.5 * (size.Height - 20) + 10));
        }

        private static int TrailAlpha(DateTime at, DateTime now) {
            double remaining = 1 - Math.Max(0, (now - at).TotalMilliseconds) / TrailLifetimeMs;
            return remaining <= 0 ? 0 : (int)Math.Round(210 * remaining * remaining);
        }

        private void PruneTrail(DateTime now) {
            DateTime cutoff = now.AddMilliseconds(-TrailLifetimeMs);
            // Keep one boundary sample so a sparse segment can be clipped at the time window.
            while (trail.Count > 1 && trail[1].At <= cutoff) trail.RemoveAt(0);
            if (trail.Count == 1 && trail[0].At <= cutoff) trail.Clear();
            if (trail.Count > MaxTrailPoints) trail.RemoveRange(0, trail.Count - MaxTrailPoints);
        }

        private void Tick(DateTime now) {
            bool hadTrail = trail.Count > 1;
            if (dotVisible && (now - lastPoint).TotalSeconds > 3) HideDot();
            PruneTrail(now);
            // Redraw while aging, including the final clear after movement stops.
            if (frameDirty || hadTrail || trail.Count > 1) RenderLayeredFrame(now);
        }

        private void DrawFrame(Graphics graphics, DateTime now, Size size) {
            graphics.CompositingMode = CompositingMode.SourceCopy;
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceOver;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            DateTime cutoff = now.AddMilliseconds(-TrailLifetimeMs);
            for (int i = 1; i < trail.Count; i++) {
                TrailSample a = trail[i - 1], b = trail[i];
                if (b.At <= cutoff) continue;
                double startX = a.X, startY = a.Y;
                DateTime startAt = a.At;
                if (a.At < cutoff && b.At > a.At) {
                    double fraction = (cutoff - a.At).TotalMilliseconds / (b.At - a.At).TotalMilliseconds;
                    startX += (b.X - a.X) * fraction;
                    startY += (b.Y - a.Y) * fraction;
                    startAt = cutoff;
                }
                PointF start = MapPoint(startX, startY, size), end = MapPoint(b.X, b.Y, size);
                if (Math.Abs(end.X - start.X) + Math.Abs(end.Y - start.Y) < 0.01) continue;
                Color oldColor = Color.FromArgb(TrailAlpha(startAt, now), 255, 0, 0);
                Color newColor = Color.FromArgb(TrailAlpha(b.At, now), 255, 0, 0);
                using (LinearGradientBrush brush = new LinearGradientBrush(start, end, oldColor, newColor))
                using (Pen pen = new Pen(brush, 6)) {
                    pen.StartCap = pen.EndCap = LineCap.Round;
                    graphics.DrawLine(pen, start, end);
                }
            }
            if (!dotVisible) return;
            PointF dot = MapPoint(x, y, size);
            graphics.FillEllipse(Brushes.Red, dot.X - 10, dot.Y - 10, 20, 20);
            graphics.FillEllipse(Brushes.White, dot.X - 2, dot.Y - 2, 4, 4);
        }

        private void DisposeSurface() {
            if (surfaceGraphics != null) { surfaceGraphics.Dispose(); surfaceGraphics = null; }
            if (surface != null) { surface.Dispose(); surface = null; }
            if (memoryDc != IntPtr.Zero && previousBitmap != IntPtr.Zero) SelectObject(memoryDc, previousBitmap);
            if (dib != IntPtr.Zero) { DeleteObject(dib); dib = IntPtr.Zero; }
            if (memoryDc != IntPtr.Zero) { DeleteDC(memoryDc); memoryDc = IntPtr.Zero; }
            previousBitmap = IntPtr.Zero;
        }

        private void RenderLayeredFrame(DateTime now) {
            if (!IsHandleCreated || IsDisposed || ClientSize.Width < 1 || ClientSize.Height < 1) return;
            if (surface == null || surface.Size != ClientSize) {
                DisposeSurface();
                BitmapInfo info = new BitmapInfo {
                    Size = (uint)Marshal.SizeOf(typeof(BitmapInfo)), Width = ClientSize.Width,
                    Height = -ClientSize.Height, Planes = 1, BitCount = 32
                };
                IntPtr bits;
                memoryDc = CreateCompatibleDC(IntPtr.Zero);
                dib = CreateDIBSection(IntPtr.Zero, ref info, 0, out bits, IntPtr.Zero, 0);
                if (memoryDc == IntPtr.Zero || dib == IntPtr.Zero)
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                previousBitmap = SelectObject(memoryDc, dib);
                // A top-down premultiplied surface supplies real per-pixel alpha to Windows.
                surface = new Bitmap(ClientSize.Width, ClientSize.Height, ClientSize.Width * 4,
                    PixelFormat.Format32bppPArgb, bits);
                surfaceGraphics = Graphics.FromImage(surface);
            }
            DrawFrame(surfaceGraphics, now, ClientSize);
            surfaceGraphics.Flush();
            NativePoint position = new NativePoint { X = Left, Y = Top };
            NativePoint source = new NativePoint();
            NativeSize size = new NativeSize { Width = ClientSize.Width, Height = ClientSize.Height };
            BlendFunction blend = new BlendFunction { ConstantAlpha = 255, AlphaFormat = 1 };
            if (!UpdateLayeredWindow(Handle, IntPtr.Zero, ref position, ref size, memoryDc, ref source, 0, ref blend, 2))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            frameDirty = false;
        }

        private void Post(Action action) {
            try { if (!IsDisposed && IsHandleCreated) BeginInvoke(action); }
            catch (InvalidOperationException) { }
        }

        private void HideDot() {
            dotVisible = false;
            trail.Clear();
            frameDirty = true;
            RenderLayeredFrame(DateTime.UtcNow);
        }

        private void Apply(Message message) {
            if (message.Type == "point" && message.Point != null && message.Point.Length == 2) {
                if (double.IsNaN(message.Point[0]) || double.IsInfinity(message.Point[0]) ||
                    double.IsNaN(message.Point[1]) || double.IsInfinity(message.Point[1])) return;
                double nextX = Math.Max(-1, Math.Min(1, message.Point[0]));
                double nextY = Math.Max(-1, Math.Min(1, message.Point[1]));
                bool moved = !dotVisible || Math.Abs(nextX - x) + Math.Abs(nextY - y) > 0.000001;
                x = nextX;
                y = nextY;
                dotVisible = true;
                lastPoint = DateTime.UtcNow;
                PruneTrail(lastPoint);
                // Repeated stationary samples must not keep an old segment alive.
                if (trail.Count == 0 || Math.Abs(trail[trail.Count - 1].X - x) + Math.Abs(trail[trail.Count - 1].Y - y) > 0.000001)
                    trail.Add(new TrailSample { X = x, Y = y, At = lastPoint });
                if (trail.Count > MaxTrailPoints) trail.RemoveRange(0, trail.Count - MaxTrailPoints);
                frameDirty |= moved;
            } else if (message.Type == "reset") {
                trail.Clear();
                x = y = 0;
                dotVisible = true;
                lastPoint = DateTime.UtcNow;
                frameDirty = true;
            } else if (message.Type == "presence" && !message.Connected) {
                HideDot();
            } else if (message.Type == "page" && (message.Direction == "next" || message.Direction == "previous")) {
                // SendInput targets the foreground application without activating this window.
                ushort key = (ushort)(message.Direction == "next" ? Keys.Right : Keys.Left);
                Input down = new Input { Type = 1 };
                down.Data.Keyboard.Key = key;
                down.Data.Keyboard.Flags = 0x0001;
                Input up = down;
                up.Data.Keyboard.Flags |= 0x0002;
                Input[] inputs = { down, up };
                if (SendInput(2, inputs, Marshal.SizeOf(typeof(Input))) != 2)
                    Console.Error.WriteLine("Page key could not be sent. Keep Canva focused and use the same privilege level.");
            }
        }

        private async Task NetworkLoop() {
            bool errorReported = false;
            while (!stop.IsCancellationRequested) {
                try {
                    using (ClientWebSocket client = new ClientWebSocket()) {
                        socket = client;
                        client.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                        await client.ConnectAsync(endpoint, stop.Token).ConfigureAwait(false);
                        Console.WriteLine("Overlay connected. Ctrl+Alt+Q exits.");
                        errorReported = false;
                        byte[] buffer = new byte[2048];
                        while (!stop.IsCancellationRequested && client.State == WebSocketState.Open) {
                            using (MemoryStream data = new MemoryStream()) {
                                WebSocketReceiveResult part;
                                do {
                                    part = await client.ReceiveAsync(new ArraySegment<byte>(buffer), stop.Token).ConfigureAwait(false);
                                    if (part.MessageType == WebSocketMessageType.Close)
                                        throw new WebSocketException("Server closed the connection.");
                                    if (part.MessageType != WebSocketMessageType.Text)
                                        throw new InvalidDataException("Only JSON text messages are supported.");
                                    data.Write(buffer, 0, part.Count);
                                    if (data.Length > 16384) throw new InvalidDataException("Message exceeds 16 KiB.");
                                } while (!part.EndOfMessage);
                                data.Position = 0;
                                Message message;
                                try {
                                    message = (Message)new DataContractJsonSerializer(typeof(Message)).ReadObject(data);
                                } catch (SerializationException) { continue; }
                                if (message != null) Post(delegate { Apply(message); });
                            }
                        }
                    }
                } catch (Exception error) {
                    if (!stop.IsCancellationRequested && !errorReported) {
                        Console.Error.WriteLine("Overlay reconnecting: " + error.Message +
                            " Check server reachability and Windows certificate trust.");
                        errorReported = true;
                    }
                } finally {
                    socket = null;
                    Post(HideDot);
                }
                try { await Task.Delay(1200, stop.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e) {
            UnregisterHotKey(Handle, HotkeyId);
            staleTimer.Stop();
            stop.Cancel();
            ClientWebSocket active = socket;
            if (active != null) active.Abort();
            base.OnFormClosed(e);
        }

        protected override void Dispose(bool disposing) {
            if (disposing) {
                staleTimer.Stop();
                staleTimer.Dispose();
                stop.Cancel();
                ClientWebSocket active = socket;
                if (active != null) active.Abort();
                DisposeSurface();
            }
            base.Dispose(disposing);
        }
    }
}
'@
}

if ($Check) {
    Write-Output ('Overlay compiled successfully. Available monitors: ' + [System.Windows.Forms.Screen]::AllScreens.Length)
    return
}

if ($Url) {
    if ($Url.Scheme -ne 'wss') { throw '-Url must use wss:// with a trusted certificate.' }
    $endpoint = $Url.AbsoluteUri
} else {
    if ($Server.Scheme -ne 'https') { throw '-Server must use https:// with a trusted certificate.' }
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        $config = Invoke-RestMethod -Uri ($Server.AbsoluteUri.TrimEnd('/') + '/api/config')
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
    }
    if (-not $config.room) { throw 'The server did not return a room in /api/config.' }
    $builder = New-Object UriBuilder($Server)
    $builder.Scheme = 'wss'
    $builder.Path = '/ws'
    $builder.Query = 'role=overlay&room=' + [Uri]::EscapeDataString([string]$config.room)
    $endpoint = $builder.Uri.AbsoluteUri
}

Write-Host ('Starting overlay on monitor ' + $Monitor + '. Focus Canva after starting. Press Ctrl+Alt+Q to exit.')
$previousDpi = [LanLaser.Overlay]::EnterDpiContext()
$overlay = $null
try {
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $overlay = New-Object LanLaser.Overlay($endpoint, $Monitor)
    [System.Windows.Forms.Application]::Run($overlay)
} finally {
    if ($overlay) { $overlay.Dispose() }
    [LanLaser.Overlay]::LeaveDpiContext($previousDpi)
}
