# Installs tmb from the public release repo. No login needed.
#   irm https://github.com/trustmybot/tmb-releases/releases/download/dev/install.ps1 | iex
# $env:TMB_CHANNEL picks the channel: dev (default), rc or stable. Each channel installs under
# its own name, so they live side by side: tmb follows stable, tmb-rc rc and tmb-dev dev, and
# each updates itself from its own channel between sessions.
# $env:TMB_INSTALL_VERSION = 'X.Y.Z' (or 'X.Y.Z-rc.N') installs that one release as
# tmb-X.Y.Z instead, which never updates itself.
# $env:TMB_NO_MODIFY_PATH = '1' leaves the user PATH alone and prints the line instead.
$ErrorActionPreference = 'Stop'

# The channel installed when TMB_CHANNEL is unset. dev until a stable release exists; then
# change it to stable, here and in install.sh.
$defaultChannel = 'dev'

$channel = if ($env:TMB_CHANNEL) { $env:TMB_CHANNEL } else { $defaultChannel }
$pinned = if ($env:TMB_INSTALL_VERSION) { $env:TMB_INSTALL_VERSION.TrimStart('v') } else { '' }
if ($channel -notin @('dev', 'rc', 'stable')) { throw "unknown channel $channel; use dev, rc or stable" }
if ($pinned) {
    # dev is one rolling release, so only rc and stable releases can be pinned.
    if ($pinned -notmatch '^\d+\.\d+\.\d+(-rc\.\d+)?$') { throw "cannot pin ${pinned}: name a stable X.Y.Z or rc X.Y.Z-rc.N release" }
    $name = "tmb-$pinned"
    $label = "release v$pinned"
}
elseif ($channel -eq 'stable') { $name = 'tmb'; $label = 'stable channel' }
else { $name = "tmb-$channel"; $label = "$channel channel" }
$releasesUrl = if ($env:TMB_RELEASES_URL) { $env:TMB_RELEASES_URL } else { 'https://github.com/trustmybot/tmb-releases' }
$releasesApi = if ($env:TMB_RELEASES_API) { $env:TMB_RELEASES_API } else { 'https://api.github.com/repos/trustmybot/tmb-releases' }
# dev is a rolling release and stable is the release marked latest; rc's newest tag is read
# from the public releases API, as tmb's own update check does.
if ($pinned) { $baseUrl = "$releasesUrl/releases/download/v$pinned" }
else { switch ($channel) {
    'dev' { $baseUrl = "$releasesUrl/releases/download/dev" }
    'stable' { $baseUrl = "$releasesUrl/releases/latest/download" }
    'rc' {
        $tags = (Invoke-RestMethod -UseBasicParsing -Uri "$releasesApi/releases?per_page=100") |
            Where-Object { -not $_.draft -and $_.tag_name -match '^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$' } |
            Sort-Object { $null = $_.tag_name -match '^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$'; [version]"$($Matches[1]).$($Matches[2]).$($Matches[3]).$($Matches[4])" }
        if (-not $tags) { throw 'the rc channel has no release yet' }
        $baseUrl = "$releasesUrl/releases/download/$(@($tags)[-1].tag_name)"
    }
} }
$binDir = Join-Path $env:USERPROFILE '.local\bin'

# Only an x64 build is published; Windows on Arm runs it under emulation.
$asset = 'tmb-windows-x64.exe'

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tmb-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    Write-Host "Downloading $asset from the $label..."
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
    $target = Join-Path $binDir "$name.exe"
    Move-Item -Force -Path $download -Destination $target
    $installed = & $target --version
    if ($pinned -and (($installed -split '\s+')[1] -ne $pinned)) {
        Remove-Item -Force -Path $target
        throw "release v$pinned holds $installed, not $pinned"
    }
    Write-Host "Installed $name at ${target}: $installed"

    # Before the channels had their own names, every channel installed as tmb. Such a tmb keeps
    # following the channel it was on, and projects set up with it keep calling it.
    $plain = Join-Path $binDir 'tmb.exe'
    if ($name -ne 'tmb' -and (Test-Path $plain)) {
        $legacyVersion = ((& $plain --version 2>$null) -split '\s+')[1]
        if ($legacyVersion -match '-(dev|rc)\.') {
            Write-Host "$plain is $legacyVersion, installed before the channels had their own names; it keeps following its channel. Run $name init in a project to move it to $name."
        }
    }

    $legacyDir = Join-Path $env:LOCALAPPDATA 'tmb\bin'
    $legacyExe = Join-Path $legacyDir 'tmb.exe'
    if (Test-Path $legacyExe) {
        Remove-Item -Force -Path $legacyExe
        foreach ($dir in @($legacyDir, (Split-Path $legacyDir -Parent))) {
            if ((Test-Path $dir) -and -not (Get-ChildItem -Force -Path $dir)) {
                Remove-Item -Force -Path $dir -ErrorAction SilentlyContinue
            }
        }
        Write-Host "Removed the old %LOCALAPPDATA%\tmb\bin\tmb.exe. In projects set up with it, run $name init again."
    }

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $userEntries = @(if ($userPath) { $userPath -split ';' | Where-Object { $_ } })
    if (-not ($userEntries -contains $binDir)) {
        $pathLine = "[Environment]::SetEnvironmentVariable('Path', `"$binDir;`$([Environment]::GetEnvironmentVariable('Path','User'))`", 'User')"
        if ($env:TMB_NO_MODIFY_PATH -eq '1') {
            Write-Host 'Add tmb to your PATH, e.g.:'
            Write-Host "  $pathLine"
        }
        else {
            [Environment]::SetEnvironmentVariable('Path', ((@($binDir) + $userEntries) -join ';'), 'User')
            $env:Path = if ($env:Path) { "$binDir;$env:Path" } else { $binDir }
            Write-Host "Added $binDir to your user PATH. Open a new terminal."
        }
    }

    Write-Host "Run $name init in a project, then start claude there."
}
catch {
    Write-Error "tmb install: $_"
    exit 1
}
finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}
