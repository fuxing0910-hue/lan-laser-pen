[CmdletBinding()]
param(
    [string[]]$LanIP = @(),
    [switch]$InstallTrust,
    [string]$MkcertPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$certDirectory = Join-Path $projectRoot 'certs'
$toolsDirectory = Join-Path $projectRoot '.tools'

if ($env:OS -ne 'Windows_NT') {
    throw 'Run this setup script on Windows. On other systems, use mkcert to create certs/lan.pem and certs/lan-key.pem.'
}

function Test-PrivateIPv4 {
    param([string]$Address)

    $parsedAddress = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) { return $false }
    if ($parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $bytes = $parsedAddress.GetAddressBytes()
    return ($bytes[0] -eq 10) -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Invoke-Mkcert {
    param([string[]]$Arguments)

    & $script:mkcertExecutable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "mkcert failed with exit code $LASTEXITCODE." }
}

# Use the installed tool when available, otherwise download a pinned official release.
if ($MkcertPath) {
    $mkcertExecutable = (Resolve-Path -LiteralPath $MkcertPath).Path
} else {
    $installedMkcert = Get-Command 'mkcert.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installedMkcert) {
        $mkcertExecutable = $installedMkcert.Source
    } else {
        $architecture = $env:PROCESSOR_ARCHITEW6432
        if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
        switch ($architecture.ToUpperInvariant()) {
            'AMD64' {
                $assetArchitecture = 'amd64'
                $expectedHash = 'D2660B50A9ED59EADA480750561C96ABC2ED4C9A38C6A24D93E30E0977631398'
            }
            'ARM64' {
                $assetArchitecture = 'arm64'
                $expectedHash = '793747256C562622D40127C8080DF26ADD2FB44C50906CE9DB63B42A5280582E'
            }
            default { throw "Unsupported Windows architecture: $architecture. Install mkcert manually and pass -MkcertPath." }
        }

        # Hashes are pinned from Microsoft's winget-pkgs manifest for mkcert 1.4.4.
        # https://github.com/microsoft/winget-pkgs/blob/master/manifests/f/FiloSottile/mkcert/1.4.4/FiloSottile.mkcert.installer.yaml
        $assetName = "mkcert-v1.4.4-windows-$assetArchitecture.exe"
        $mkcertExecutable = Join-Path $toolsDirectory $assetName
        New-Item -ItemType Directory -Path $toolsDirectory -Force | Out-Null
        if (-not (Test-Path -LiteralPath $mkcertExecutable -PathType Leaf)) {
            $downloadUrl = "https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/$assetName"
            $downloadPath = "$mkcertExecutable.download"
            Write-Host "Downloading mkcert 1.4.4 from the official GitHub release: $downloadUrl"
            $previousProtocol = [System.Net.ServicePointManager]::SecurityProtocol
            try {
                [System.Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [System.Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $downloadPath
                if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash -ne $expectedHash) {
                    throw 'mkcert SHA-256 verification failed. The downloaded file will not be executed.'
                }
                Move-Item -LiteralPath $downloadPath -Destination $mkcertExecutable -Force
            } finally {
                [System.Net.ServicePointManager]::SecurityProtocol = $previousProtocol
                if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath -Force }
            }
        }
        if ((Get-FileHash -LiteralPath $mkcertExecutable -Algorithm SHA256).Hash -ne $expectedHash) {
            throw "Cached mkcert SHA-256 verification failed. Remove $mkcertExecutable and rerun setup."
        }
    }
}

$addresses = @()
if ($LanIP.Count -gt 0) {
    foreach ($addressArgument in $LanIP) {
        foreach ($address in $addressArgument.Split(',')) {
            $address = $address.Trim()
            if (-not (Test-PrivateIPv4 $address)) {
                throw "Invalid LAN IPv4 address: $address. Use an address in 10.x.x.x, 172.16-31.x.x, or 192.168.x.x."
            }
            $addresses += [System.Net.IPAddress]::Parse($address).ToString()
        }
    }
} else {
    foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
        foreach ($unicastAddress in $networkInterface.GetIPProperties().UnicastAddresses) {
            $address = $unicastAddress.Address.ToString()
            if (Test-PrivateIPv4 $address) { $addresses += $address }
        }
    }
}
$addresses = @($addresses | Sort-Object -Unique)
if ($addresses.Count -eq 0) {
    throw 'No active private IPv4 address found. Connect the PC to your LAN, or pass -LanIP with its LAN IPv4 address.'
}

# Keep the signing key outside the project and outside any served directory.
$caRootOutput = & $mkcertExecutable '-CAROOT'
if ($LASTEXITCODE -ne 0) { throw 'Unable to find the mkcert CA directory.' }
$caRoot = [System.IO.Path]::GetFullPath(($caRootOutput | Out-String).Trim())
$projectPrefix = $projectRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if ($caRoot.Equals($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $caRoot.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The mkcert CAROOT directory must be outside this project. Remove or change your CAROOT environment variable and rerun setup.'
}

New-Item -ItemType Directory -Path $certDirectory -Force | Out-Null
$certificatePath = Join-Path $certDirectory 'lan.pem'
$keyPath = Join-Path $certDirectory 'lan-key.pem'
$certificateNames = @('localhost', '127.0.0.1', '::1') + $addresses
Invoke-Mkcert -Arguments (@('-cert-file', $certificatePath, '-key-file', $keyPath) + $certificateNames)

# Export only the public CA certificate as DER for mobile certificate installers.
$caPemPath = Join-Path $caRoot 'rootCA.pem'
$caPem = [System.IO.File]::ReadAllText($caPemPath)
$caMatch = [System.Text.RegularExpressions.Regex]::Match($caPem, '-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----')
if (-not $caMatch.Success) { throw "Cannot read the public CA certificate: $caPemPath" }
$caExportPath = Join-Path $certDirectory 'rootCA.cer'
[System.IO.File]::WriteAllBytes($caExportPath, [System.Convert]::FromBase64String($caMatch.Groups[1].Value))

if ($InstallTrust) {
    # Trust only this user's Windows store; no administrator or machine-wide change is needed.
    Import-Certificate -FilePath $caExportPath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    Write-Host 'Installed the public local CA in the current Windows user root store.'
}

Write-Host ''
Write-Host "HTTPS certificate: $certificatePath"
Write-Host "Server private key: $keyPath (keep this on the PC)"
Write-Host "Public CA for phone installation: $caExportPath"
Write-Host "Public CA SHA-256: $((Get-FileHash -LiteralPath $caExportPath -Algorithm SHA256).Hash)"
Write-Host "Certificate LAN names: $($addresses -join ', ')"
Write-Host ''
if (-not $InstallTrust) {
    Write-Host 'Desktop trust was not changed. To install the CA on this PC, rerun this script with -InstallTrust.'
}
Write-Host 'Copy ONLY certs/rootCA.cer to the phone (USB or another trusted local transfer).'
Write-Host 'Install it as a CA certificate, then enable full trust if the phone provides that setting.'
Write-Host 'Never copy rootCA-key.pem from the mkcert CA directory to this project or to a phone.'
Write-Host 'Reopen the phone browser and verify that HTTPS loads without a certificate warning.'
Write-Host 'Accepting a certificate warning alone is not a reliable secure context for motion sensors.'
Write-Host 'Phone trust settings and browser sensor support vary by HarmonyOS / Android / iOS version.'
Write-Host 'Start the app, then use the LAN address that is on the same network as your phone:'
foreach ($address in $addresses) { Write-Host "  https://${address}:8443" }
Write-Host 'If the PC LAN address changes, rerun this script and restart the app.'
