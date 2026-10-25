[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8443,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this optional script from an Administrator PowerShell window. No firewall settings were changed.'
}

$ruleName = "LaserPen.LocalHttps.Inbound.$Port"
$existingRule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue

if ($Remove) {
    if ($existingRule) {
        if ($PSCmdlet.ShouldProcess($ruleName, 'Remove the laser pen LAN firewall rule')) {
            Remove-NetFirewallRule -Name $ruleName | Out-Null
            Write-Host "Firewall rule removed: $ruleName"
        }
    } else {
        Write-Host "Firewall rule already absent: $ruleName"
    }
    return
}

if ($PSCmdlet.ShouldProcess($ruleName, "Allow inbound TCP $Port only on Private networks from LocalSubnet")) {
    if ($existingRule) { Remove-NetFirewallRule -Name $ruleName | Out-Null }
    New-NetFirewallRule -Name $ruleName -DisplayName "Laser Pen LAN HTTPS ($Port)" `
        -Group 'Laser Pen LAN' -Direction Inbound -Action Allow -Enabled True `
        -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet `
        -EdgeTraversalPolicy Block | Out-Null
    Write-Host "Allowed TCP $Port from LocalSubnet on Private networks only."
    Write-Host 'This script does not change your network profile. Use only a trusted LAN.'
    Write-Host "To undo: powershell -ExecutionPolicy Bypass -File .\scripts\allow-firewall.ps1 -Port $Port -Remove"
}
