# Installs tmb from the public release repo. No login needed.
#   irm https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1 | iex
# $env:TMB_CHANNEL picks the channel (default: dev).
$ErrorActionPreference = 'Stop'

$channel = if ($env:TMB_CHANNEL) { $env:TMB_CHANNEL } else { 'dev' }
$baseUrl = "https://github.com/trustmybot/tmb-releases/releases/download/$channel"
$binDir = Join-Path $env:LOCALAPPDATA 'tmb\bin'

# Only an x64 build is published; Windows on Arm runs it under emulation.
$asset = 'tmb-windows-x64.exe'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tmb-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $asset from the $channel channel..."
    $download = Join-Path $tmp $asset
    $sums = Join-Path $tmp 'SHA256SUMS'
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$asset" -OutFile $download
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $sums

    $expected = $null
    foreach ($line in Get-Content $sums) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $asset) { $expected = $parts[0].ToLower() }
    }
    if (-not $expected) { throw "no checksum for $asset in SHA256SUMS" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
    if ($expected -ne $actual) { throw "checksum mismatch for ${asset}: expected $expected, got $actual" }

    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $target = Join-Path $binDir 'tmb.exe'
    Move-Item -Force -Path $download -Destination $target
    Write-Host "Installed $(& $target --version) to $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $binDir)) {
        Write-Host 'Add tmb to your PATH, e.g.:'
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$binDir;`$([Environment]::GetEnvironmentVariable('Path','User'))`", 'User')"
    }
}
catch {
    Write-Error "tmb install: $_"
    exit 1
}
finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}
