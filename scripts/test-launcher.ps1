[CmdletBinding()]
param([ValidateRange(1024, 65535)][int]$Port = 18443)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
$stateFile = Join-Path $root ".tools/launcher-$Port.json"
$serverScript = Join-Path $root 'server.cjs'
$serverTimestamp = (Get-Item -LiteralPath $serverScript).LastWriteTimeUtc
$roomEnvironment = [Environment]::GetEnvironmentVariable('LASER_PEN_ROOM', 'Process')
$externalRoom = 'a' * 36
$fixture = $null
$fixturePath = Join-Path $root '.tools/launcher-test-fixture.cjs'
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Test port is already in use.' }

try {
    $env:LASER_PEN_ROOM = $externalRoom
    & $launcher -Action Start -Port $Port -NoBrowser -NoOverlay -NoUi
    $first = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $firstConfig = Invoke-RestMethod -Uri "https://127.0.0.1:$Port/api/config" -TimeoutSec 3
    if ($firstConfig.room -eq $externalRoom) { throw 'Start inherited a caller-supplied room.' }
    if ($env:LASER_PEN_ROOM -ne $externalRoom) { throw 'Start did not restore the caller room environment.' }
    & $launcher -Action Start -Port $Port -NoBrowser -NoOverlay -NoUi
    $second = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($first.server.pid -ne $second.server.pid) { throw 'Repeated Start created a second server.' }

    # Trigger a source update without changing file contents or the live default-port service.
    $serverStartedAt = (Get-Process -Id $first.server.pid).StartTime.ToUniversalTime()
    try {
        [IO.File]::SetLastWriteTimeUtc($serverScript, $serverStartedAt.AddSeconds(1))
        & $launcher -Action Start -Port $Port -NoBrowser -NoOverlay -NoUi
    } finally {
        [IO.File]::SetLastWriteTimeUtc($serverScript, $serverTimestamp)
    }
    $updated = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $updatedConfig = Invoke-RestMethod -Uri "https://127.0.0.1:$Port/api/config" -TimeoutSec 3
    if ($first.server.pid -eq $updated.server.pid) { throw 'A source update did not restart its managed server.' }
    if ($firstConfig.room -ne $updatedConfig.room) { throw 'A source update lost the current phone pairing.' }
    if ($env:LASER_PEN_ROOM -ne $externalRoom) { throw 'A source update did not restore the caller room environment.' }
    & $launcher -Action Stop -Port $Port -NoUi
    if (Get-Process -Id $updated.server.pid -ErrorAction SilentlyContinue) { throw 'Stop left its managed server running.' }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Stop did not free the port.' }

    & $launcher -Action Start -Port $Port -NoBrowser -NoOverlay -NoUi
    $freshConfig = Invoke-RestMethod -Uri "https://127.0.0.1:$Port/api/config" -TimeoutSec 3
    if ($freshConfig.room -eq $updatedConfig.room) { throw 'Stop followed by Start reused the previous pairing.' }
    if ($freshConfig.room -eq $externalRoom) { throw 'A manual restart inherited a caller-supplied room.' }
    & $launcher -Action Stop -Port $Port -NoUi

    # An unrelated process must survive even if a state file contains its PID and creation time.
    Set-Content -LiteralPath $fixturePath -Value 'setInterval(() => {}, 1000)' -Encoding ASCII
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $fixture = Start-Process -FilePath $node -ArgumentList ('"' + $fixturePath + '"') -WindowStyle Hidden -PassThru
    @{
        server = @{
            pid = $fixture.Id
            started = $fixture.StartTime.ToUniversalTime().Ticks.ToString()
            executable = $node
            script = (Join-Path $root 'server.cjs')
        }
        overlay = $null
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateFile -Encoding UTF8
    & $launcher -Action Stop -Port $Port -NoUi
    if (-not (Get-Process -Id $fixture.Id -ErrorAction SilentlyContinue)) { throw 'Stop terminated an unrelated process.' }
    Write-Output 'PASS: start, repeated start, pairing-preserving source update, fresh manual restart, environment restore, stop, port release and unrelated-process protection.'
} finally {
    [IO.File]::SetLastWriteTimeUtc($serverScript, $serverTimestamp)
    if ($null -eq $roomEnvironment) { Remove-Item Env:\LASER_PEN_ROOM -ErrorAction SilentlyContinue }
    else { $env:LASER_PEN_ROOM = $roomEnvironment }
    & $launcher -Action Stop -Port $Port -NoUi
    if ($fixture -and -not $fixture.HasExited) { Stop-Process -Id $fixture.Id -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue
}
