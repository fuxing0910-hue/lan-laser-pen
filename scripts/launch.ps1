[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop')][string]$Action = 'Start',
    [ValidateRange(1, 65535)][int]$Port = 8443,
    [ValidateRange(1, 32)][int]$Monitor = 1,
    [switch]$NoBrowser,
    [switch]$NoOverlay,
    [switch]$NoUi
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsDirectory = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
$statePath = Join-Path $toolsDirectory "launcher-$Port.json"
$serverScript = Join-Path $projectRoot 'server.cjs'
$overlayScript = Join-Path $PSScriptRoot 'overlay.ps1'
$baseUrl = "https://127.0.0.1:$Port"
$state = @{ server = $null; overlay = $null }
$restartRoom = $null
$created = @()
$transcribing = $false
$locked = $false
$mutex = $null

function Show-LauncherError {
    param([string]$Text)
    if ($NoUi) { Write-Error $Text -ErrorAction Continue; return }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($Text, 'Laser Pen', 'OK', 'Error') | Out-Null
}

function Save-State {
    $temporaryPath = "$statePath.tmp"
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $statePath -Force
}

function Get-OwnedProcess {
    param($Record, [string]$ScriptPath)
    if (-not $Record -or $Record.script -ne $ScriptPath) { return $null }
    $process = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    # Validate creation time and the exact script path before reusing or stopping a PID.
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$Record.started) { return $null }
    $details = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $process.Id)
    if (-not $details -or -not $details.CommandLine -or
        $details.ExecutablePath -ne $Record.executable -or
        $details.CommandLine.IndexOf(('"' + $ScriptPath + '"'), [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    return $process
}

function Stop-OwnedProcess {
    param($Record, [string]$ScriptPath)
    $process = Get-OwnedProcess $Record $ScriptPath
    if ($process) {
        Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
    }
}

function Start-OwnedProcess {
    param([string]$Executable, [string]$Arguments, [string]$ScriptPath, [string]$Name)
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $toolsDirectory "$Name.stdout.log") `
        -RedirectStandardError (Join-Path $toolsDirectory "$Name.stderr.log")
    $record = @{
        pid = $process.Id
        started = $process.StartTime.ToUniversalTime().Ticks.ToString()
        executable = $Executable
        script = $ScriptPath
    }
    return $record
}

function Get-ServerConfig {
    try {
        $response = Invoke-RestMethod -Uri "$baseUrl/api/config" -TimeoutSec 3
        if ($response.room -cmatch '^[a-f0-9]{36}$' -and [int]$response.port -eq $Port) { return $response }
    } catch { }
    return $null
}

try {
    Set-Location -LiteralPath $projectRoot
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes("$projectRoot/$Port"))).Replace('-', '') }
    finally { $hash.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\LaserPenLauncher_$key")
    try { $locked = $mutex.WaitOne($(if ($Action -eq 'Stop') { 15000 } else { 0 })) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) {
        if ($Action -eq 'Stop') { throw 'Laser Pen is still preparing. Wait a moment, then click Stop again.' }
        return
    }
    Start-Transcript -LiteralPath (Join-Path $toolsDirectory 'launcher.log') -Append | Out-Null
    $transcribing = $true
    if (Test-Path -LiteralPath $statePath) {
        try {
            $stored = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
            $state.server = $stored.server
            $state.overlay = $stored.overlay
        } catch { Write-Warning 'Ignoring a damaged launcher state file.' }
    }
    if ($Action -eq 'Stop') {
        Stop-OwnedProcess $state.overlay $overlayScript
        Stop-OwnedProcess $state.server $serverScript
        $state = @{ server = $null; overlay = $null }
        Save-State
        Write-Output 'Laser Pen stopped.'
        return
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $nodeCommand) { throw 'Node.js was not found. Install Node.js 22 or newer, then double-click Start again.' }
    $node = $nodeCommand.Source
    # Use the current network instead of inheriting a stale IP from another terminal.
    Remove-Item Env:\LAN_IP -ErrorAction SilentlyContinue
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $rebuild = $false
    if (-not (Test-Path 'node_modules/ws/package.json') -or -not (Test-Path 'node_modules/webpack/package.json')) {
        $npm = (Get-Command npm.cmd -CommandType Application | Select-Object -First 1).Source
        & $npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. See .tools/launcher.log.' }
        $rebuild = $true
    }
    $checkJson = & $node (Join-Path $PSScriptRoot 'check-https.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to check local HTTPS certificates.' }
    $certificateCheck = ($checkJson | Out-String) | ConvertFrom-Json
    if (-not $certificateCheck.ok) {
        Stop-OwnedProcess $state.overlay $overlayScript
        Stop-OwnedProcess $state.server $serverScript
        $state = @{ server = $null; overlay = $null }
        Save-State
        & (Join-Path $PSScriptRoot 'setup-https.ps1')
    }
    $caPath = Join-Path $projectRoot 'certs/rootCA.cer'
    $ca = New-Object Security.Cryptography.X509Certificates.X509Certificate2($caPath)
    if (-not (Test-Path ("Cert:\CurrentUser\Root\" + $ca.Thumbprint))) {
        # First-time trust can require a Windows confirmation; never disable certificate validation.
        Import-Certificate -FilePath $caPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    }

    $buildFiles = @('dist/index.html', 'dist/client.html', 'dist/main.bundle.js', 'dist/client.bundle.js')
    foreach ($file in $buildFiles) { if (-not (Test-Path -LiteralPath $file)) { $rebuild = $true } }
    if (-not $rebuild) {
        $builtAt = (Get-Item -LiteralPath 'dist/index.html').LastWriteTimeUtc
        # Recurse only source directories; a file-name Path with Recurse also scans node_modules.
        $sourceFiles = @(Get-ChildItem -LiteralPath @('example', 'src') -Recurse -File) +
            @(Get-Item -LiteralPath @('webpack.config.js', 'package.json', 'scripts/build.cjs'))
        $newer = $sourceFiles |
            Where-Object { $_.LastWriteTimeUtc -gt $builtAt } | Select-Object -First 1
        if ($newer) { $rebuild = $true }
    }
    if ($rebuild) {
        & $node (Join-Path $PSScriptRoot 'build.cjs') demo
        if ($LASTEXITCODE -ne 0) { throw 'Web page build failed. See .tools/launcher.log.' }
    }
    $serverProcess = Get-OwnedProcess $state.server $serverScript
    if ($serverProcess -and (Get-Item $serverScript).LastWriteTimeUtc -gt $serverProcess.StartTime.ToUniversalTime()) {
        # Keep the pairing only when updating this tracked, healthy server in place.
        $previousConfig = Get-ServerConfig
        if ($previousConfig) { $restartRoom = [string]$previousConfig.room }
        Stop-OwnedProcess $state.overlay $overlayScript
        Stop-OwnedProcess $state.server $serverScript
        $state = @{ server = $null; overlay = $null }
        $serverProcess = $null
        Save-State
    }
    if (-not $serverProcess) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw "Port $Port is already in use by another process. Stop the earlier server before clicking Start." }
        # The overlay must reconnect after a restart, including updates that retain the room.
        Stop-OwnedProcess $state.overlay $overlayScript
        $state.overlay = $null
        $env:PORT = $Port.ToString()
        $previousRoomEnvironment = [Environment]::GetEnvironmentVariable('LASER_PEN_ROOM', 'Process')
        try {
            # Never inherit a caller-supplied room for a normal or manually restarted session.
            if ($restartRoom) { $env:LASER_PEN_ROOM = $restartRoom }
            else { Remove-Item Env:\LASER_PEN_ROOM -ErrorAction SilentlyContinue }
            $state.server = Start-OwnedProcess $node ('"' + $serverScript + '"') $serverScript 'server'
        } finally {
            if ($null -eq $previousRoomEnvironment) { Remove-Item Env:\LASER_PEN_ROOM -ErrorAction SilentlyContinue }
            else { $env:LASER_PEN_ROOM = $previousRoomEnvironment }
        }
        $created += $state.server
        Save-State
    }
    $config = $null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $config = Get-ServerConfig
        if ($config) { break }
        if (-not (Get-OwnedProcess $state.server $serverScript)) { break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $config) { throw 'The local HTTPS server could not start. See .tools/server.stderr.log and check Windows certificate trust.' }
    $overlayProcess = Get-OwnedProcess $state.overlay $overlayScript
    if ($overlayProcess -and (Get-Item $overlayScript).LastWriteTimeUtc -gt $overlayProcess.StartTime.ToUniversalTime()) {
        Stop-OwnedProcess $state.overlay $overlayScript
        $state.overlay = $null
        Save-State
    }
    if (-not $NoOverlay -and -not (Get-OwnedProcess $state.overlay $overlayScript)) {
        $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
        $arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $overlayScript + '" -Server "' + $baseUrl + '" -Monitor ' + $Monitor
        $state.overlay = Start-OwnedProcess $powershell $arguments $overlayScript 'overlay'
        $created += $state.overlay
        Save-State
        # Wait for the actual WSS handshake, not just the helper process to exist.
        $overlayReady = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (-not (Get-OwnedProcess $state.overlay $overlayScript)) { break }
            $overlayOutput = Get-Content -LiteralPath (Join-Path $toolsDirectory 'overlay.stdout.log') -Raw -ErrorAction SilentlyContinue
            if ($overlayOutput -and $overlayOutput.Contains('Overlay connected.')) { $overlayReady = $true; break }
            Start-Sleep -Milliseconds 200
        }
        if (-not $overlayReady) {
            throw 'The transparent overlay could not start. See .tools/overlay.stderr.log. Ctrl+Alt+Q may already be in use.'
        }
    }
    if (-not $NoBrowser) { Start-Process $baseUrl }
    Write-Output "Laser Pen ready: $baseUrl"
} catch {
    # Clean up only processes created by this invocation, leaving existing work intact.
    foreach ($record in $created) { try { Stop-OwnedProcess $record $record.script } catch { Write-Warning $_.Exception.Message } }
    try { if ($locked) { Save-State } } catch { Write-Warning $_.Exception.Message }
    Show-LauncherError ($_.Exception.Message + "`r`n`r`nLog: " + (Join-Path $toolsDirectory 'launcher.log'))
    exit 1
} finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
    if ($locked -and $mutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
