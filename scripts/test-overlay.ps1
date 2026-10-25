[CmdletBinding()]
param(
    [ValidateRange(1, 32)][int]$Monitor = 1,
    [Uri]$Url,
    [ValidateRange(1, 60)][int]$TimeoutSeconds = 10,
    [switch]$Window,
    [string]$PreviewPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
& (Join-Path $PSScriptRoot 'overlay.ps1') -Check

$flags = [Reflection.BindingFlags]'Instance, NonPublic'
$overlayType = [LanLaser.Overlay]
$apply = $overlayType.GetMethod('Apply', $flags)
$previousDpi = [LanLaser.Overlay]::EnterDpiContext()
$overlay = $null

function Get-OverlayField([string]$Name) {
    return ,($overlayType.GetField($Name, $flags).GetValue($overlay))
}

function Assert-Overlay([bool]$Condition, [string]$Description) {
    if (-not $Condition) { throw ('Overlay assertion failed: ' + $Description) }
}

function Apply-Json([string]$Json) {
    $stream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($Json))
    try {
        $serializer = [Runtime.Serialization.Json.DataContractJsonSerializer]::new([LanLaser.Message])
        $message = $serializer.ReadObject($stream)
        $null = $apply.Invoke($overlay, [object[]]@($message))
    } finally { $stream.Dispose() }
}

function Draw-Snapshot([DateTime]$At) {
    $bitmap = [Drawing.Bitmap]::new(640, 360, [Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $null = $overlayType.GetMethod('DrawFrame', $flags).Invoke($overlay,
            [object[]]@($graphics, $At, [Drawing.Size]::new(640, 360)))
    } finally { $graphics.Dispose() }
    return $bitmap
}

function Tick-At([DateTime]$At) {
    $null = $overlayType.GetMethod('Tick', $flags).Invoke($overlay, [object[]]@($At))
}

try {
    # Cancel networking before showing the form; the default smoke test stays fully offline.
    $overlay = [LanLaser.Overlay]::new('wss://127.0.0.1:9/ws?role=overlay&room=offline-test', $Monitor)
    (Get-OverlayField 'stop').Cancel()
    Apply-Json '{"type":"point","point":[2,-0.5]}'
    Assert-Overlay ((Get-OverlayField 'x') -eq 1 -and (Get-OverlayField 'y') -eq -0.5) 'clamp and preserve normalized coordinates'
    Assert-Overlay (Get-OverlayField 'dotVisible') 'show a received point'
    Apply-Json '{"type":"presence","connected":false}'
    Assert-Overlay (-not (Get-OverlayField 'dotVisible')) 'hide after controller disconnects'
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 0) 'clear the trail after disconnecting'
    Apply-Json '{"type":"presence","connected":true}'
    Assert-Overlay (-not (Get-OverlayField 'dotVisible')) 'avoid showing stale coordinates after reconnecting'
    Apply-Json '{"type":"point","point":[0.1,0.2]}'
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 1) 'start a new path without joining the disconnected path'
    Apply-Json '{"type":"reset"}'
    Assert-Overlay ((Get-OverlayField 'x') -eq 0 -and (Get-OverlayField 'y') -eq 0) 'center after calibration'
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 0) 'clear the trail after calibration'

    # Reject invalid points and unknown page commands without emitting any keyboard input.
    Apply-Json '{"type":"point","point":[1]}'
    Apply-Json '{"type":"page","direction":"invalid-test-command"}'
    Assert-Overlay ((Get-OverlayField 'x') -eq 0) 'ignore malformed point and unsupported page direction'
    $invalidPoint = [LanLaser.Message]::new()
    $invalidPoint.Type = 'point'
    $invalidPoint.Point = @([double]::NaN, 0)
    $null = $apply.Invoke($overlay, [object[]]@($invalidPoint))
    Assert-Overlay ((Get-OverlayField 'x') -eq 0) 'ignore non-finite coordinates'

    Assert-Overlay ($overlay.Bounds -eq [Windows.Forms.Screen]::AllScreens[$Monitor - 1].Bounds) 'cover the selected monitor in physical coordinates'
    $createParams = $overlayType.GetProperty('CreateParams', $flags).GetValue($overlay, $null)
    Assert-Overlay (($createParams.ExStyle -band 0x080800A0) -eq 0x080800A0) 'retain layered, click-through, tool-window and no-activate styles'
    Assert-Overlay $overlay.TransparencyKey.IsEmpty 'use per-pixel alpha without a magenta transparency key'
    Assert-Overlay ((Get-OverlayField 'staleTimer').Interval -le 33) 'schedule fading even when no new points arrive'

    # Render the real drawing function with sparse samples and a clipped old boundary.
    Apply-Json '{"type":"point","point":[-0.8,0.5]}'
    Apply-Json '{"type":"point","point":[-0.45,-0.5]}'
    Apply-Json '{"type":"point","point":[0.2,0.2]}'
    Apply-Json '{"type":"point","point":[0.75,-0.25]}'
    $now = [DateTime]::UtcNow
    $samples = Get-OverlayField 'trail'
    $samples[0].At = $now.AddMilliseconds(-650)
    $samples[1].At = $now.AddMilliseconds(-350)
    $samples[2].At = $now.AddMilliseconds(-150)
    $samples[3].At = $now
    $overlayType.GetField('lastPoint', $flags).SetValue($overlay, $now)
    $frame = Draw-Snapshot $now
    $fadingFrame = Draw-Snapshot ($now.AddMilliseconds(150))
    $expiredFrame = Draw-Snapshot ($now.AddMilliseconds(550))
    try {
        $trailPixel = $frame.GetPixel(281, 155)
        Assert-Overlay ($frame.GetPixel(0, 0).A -eq 0) 'keep untouched background pixels fully transparent'
        Assert-Overlay ($trailPixel.A -gt 0 -and $trailPixel.A -lt 255) 'connect sparse movement samples with a translucent trail'
        Assert-Overlay ($trailPixel.R -ge 245 -and $trailPixel.G -le 3 -and $trailPixel.B -le 3) 'render a pure red trail without a magenta halo'
        Assert-Overlay ($frame.GetPixel(72, 265).A -eq 0) 'clip the part of a segment older than 500 ms'
        Assert-Overlay ($fadingFrame.GetPixel(281, 155).A -lt $trailPixel.A) 'fade by elapsed time without receiving another point'
        Assert-Overlay ($expiredFrame.GetPixel(281, 155).A -eq 0) 'fully remove the trail after 500 ms'
        Assert-Overlay ($expiredFrame.GetPixel(558, 138).A -eq 255) 'keep the current red dot after the trail expires'
        if ($PreviewPath) {
            $fullPreviewPath = [IO.Path]::GetFullPath($PreviewPath)
            $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($fullPreviewPath))
            $frame.Save($fullPreviewPath, [Drawing.Imaging.ImageFormat]::Png)
            Write-Output ('Preview: ' + $fullPreviewPath)
        }
    } finally {
        $frame.Dispose()
        $fadingFrame.Dispose()
        $expiredFrame.Dispose()
    }

    Tick-At ($now.AddMilliseconds(550))
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 0) 'prune expired samples when the phone stops'

    # Bound the history under bursts, and avoid renewing an old segment while stationary.
    $burst = [LanLaser.Message]::new()
    $burst.Type = 'point'
    for ($i = 0; $i -lt 400; $i++) {
        $burst.Point = @((-0.9 + ($i % 100) * 0.018), 0.4)
        $null = $apply.Invoke($overlay, [object[]]@($burst))
    }
    Assert-Overlay ((Get-OverlayField 'trail').Count -le 180) 'bound the trail history during high-frequency bursts'
    $beforeRepeat = (Get-OverlayField 'trail').Count
    $null = $apply.Invoke($overlay, [object[]]@($burst))
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq $beforeRepeat) 'ignore duplicate stationary trail samples'

    # Advance the stale timestamp instead of waiting for three real seconds.
    $overlayType.GetField('lastPoint', $flags).SetValue($overlay, [DateTime]::UtcNow.AddSeconds(-4))
    Tick-At ([DateTime]::UtcNow)
    Assert-Overlay (-not (Get-OverlayField 'dotVisible')) 'hide an expired point'
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 0) 'clear the trail when the sensor goes stale'

    Apply-Json '{"type":"point","point":[-0.5,0]}'
    Apply-Json '{"type":"point","point":[0.5,0]}'
    $null = $overlayType.GetMethod('HideDot', $flags).Invoke($overlay, [object[]]@())
    Assert-Overlay ((Get-OverlayField 'trail').Count -eq 0 -and -not (Get-OverlayField 'dotVisible')) 'clear on the exact WebSocket-disconnect path'

    if ($Window) {
        # This opt-in mode needs Ctrl+Alt+Q to be free; it never sends a real keyboard event.
        $overlay.Show()
        [Windows.Forms.Application]::DoEvents()
        Assert-Overlay (-not $overlay.IsDisposed -and $overlay.Visible) 'create the per-pixel alpha window and reserve Ctrl+Alt+Q'
        Assert-Overlay ($overlay.Bounds -eq [Windows.Forms.Screen]::AllScreens[$Monitor - 1].Bounds) 'retain physical monitor bounds after showing'
        $quitMessage = [Windows.Forms.Message]::Create($overlay.Handle, 0x0312, [IntPtr]19476, [IntPtr]::Zero)
        $null = $overlayType.GetMethod('WndProc', $flags).Invoke($overlay, [object[]]@($quitMessage))
        Assert-Overlay $overlay.IsDisposed 'close through the registered hotkey handler'
    }
    Write-Output ('PASS: offline alpha/trail overlay smoke on PowerShell ' + $PSVersionTable.PSVersion + ', monitor ' + $Monitor)

    if ($Url) {
        if ($Url.Scheme -ne 'wss') { throw '-Url must use wss:// with a certificate trusted by Windows.' }
        # Check WSS with normal OS certificate verification and no window or page-key handling.
        $probe = [Net.WebSockets.ClientWebSocket]::new()
        $cancel = [Threading.CancellationTokenSource]::new()
        $cancel.CancelAfter($TimeoutSeconds * 1000)
        try {
            $null = $probe.ConnectAsync($Url, $cancel.Token).GetAwaiter().GetResult()
            $buffer = New-Object byte[] 16384
            $segment = [ArraySegment[byte]]::new($buffer)
            $part = $probe.ReceiveAsync($segment, $cancel.Token).GetAwaiter().GetResult()
            Assert-Overlay ($part.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Text) 'receive a JSON message from WSS'
            Assert-Overlay $part.EndOfMessage 'receive the initial presence message in one frame'
            $initial = [Text.Encoding]::UTF8.GetString($buffer, 0, $part.Count) | ConvertFrom-Json
            Assert-Overlay ($initial.type -eq 'presence') 'receive the local relay presence handshake'
            Write-Output ('PASS: trusted WSS connected to ' + $Url.Host + ':' + $Url.Port)
        } finally {
            $probe.Abort()
            $probe.Dispose()
            $cancel.Dispose()
        }
    }
} finally {
    if ($overlay) { $overlay.Dispose() }
    [LanLaser.Overlay]::LeaveDpiContext($previousDpi)
}
