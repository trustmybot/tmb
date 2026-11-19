# Install smoke test for Windows: runs the published installer into a throwaway USERPROFILE,
# then checks the installed binary end to end.
#   pwsh tests/install/smoke.ps1 [-Channel dev] [-ExpectedVersion X.Y.Z-dev.N]
# With -ExpectedVersion, `tmb --version` must report it.
param(
    [string]$Channel = $(if ($env:TMB_CHANNEL) { $env:TMB_CHANNEL } else { 'dev' }),
    [string]$ExpectedVersion = $env:TMB_EXPECTED_VERSION
)
$ErrorActionPreference = 'Stop'

$releasesUrl = 'https://github.com/trustmybot/tmb-releases'
$installerUrl = switch ($Channel) {
    'stable' { "$releasesUrl/releases/latest/download/install.ps1" }
    'rc' {
        if (-not $ExpectedVersion) { Write-Host 'FAIL the rc channel needs an expected version'; exit 1 }
        "$releasesUrl/releases/download/v$ExpectedVersion/install.ps1"
    }
    default { "$releasesUrl/releases/download/$Channel/install.ps1" }
}
$script:failures = 0
function Pass([string]$message) { Write-Host "PASS $message" }
function Fail([string]$message) { Write-Host "FAIL $message"; $script:failures++ }
function Show-Log([string]$file) {
    if (Test-Path $file) { Get-Content $file | ForEach-Object { Write-Host "  | $_" } }
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("tmb-smoke-" + [System.Guid]::NewGuid())
$fakeProfile = Join-Path $work 'home'
$project = Join-Path $work 'project'
New-Item -ItemType Directory -Force -Path $fakeProfile, $project | Out-Null
$tmb = Join-Path $fakeProfile '.local\bin\tmb.exe'
$saved = @{ USERPROFILE = $env:USERPROFILE; LOCALAPPDATA = $env:LOCALAPPDATA; TMB_CHANNEL = $env:TMB_CHANNEL; TMB_NO_MODIFY_PATH = $env:TMB_NO_MODIFY_PATH }

# A function, so `return` after a fatal failure skips the later checks but still reaches the summary.
function Invoke-Smoke {
    # Downloaded to a file and run from there, so a download failure is told apart from an install failure.
    $installer = Join-Path $work 'install.ps1'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $installer
        Pass "download installer from $installerUrl"
    }
    catch {
        Fail "download installer from ${installerUrl}: $_"
        return
    }

    # The installer reads these; TMB_NO_MODIFY_PATH keeps it off the user Path in the registry.
    $env:USERPROFILE = $fakeProfile
    $env:LOCALAPPDATA = Join-Path $fakeProfile 'AppData\Local'
    $env:TMB_CHANNEL = $Channel
    $env:TMB_NO_MODIFY_PATH = '1'
    $shell = (Get-Process -Id $PID).Path
    $installLog = Join-Path $work 'install.log'
    # A child shell, because the installer ends with `exit` on failure.
    & $shell -NoProfile -ExecutionPolicy Bypass -File $installer *> $installLog
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmb)) {
        Pass "installer put tmb at %USERPROFILE%\.local\bin\tmb.exe"
    }
    else {
        Show-Log $installLog
        Fail "installer put tmb at %USERPROFILE%\.local\bin\tmb.exe (exit $LASTEXITCODE)"
        return
    }

    $versionLine = (& $tmb --version 2>&1 | Out-String).Trim()
    $installedVersion = ($versionLine -split '\s+')[1]
    if ($LASTEXITCODE -ne 0) {
        Fail "tmb --version exited ${LASTEXITCODE}: $versionLine"
    }
    elseif ($ExpectedVersion -and $installedVersion -ne $ExpectedVersion) {
        Fail "tmb --version: expected $ExpectedVersion, got '$versionLine'"
    }
    else {
        Pass "tmb --version: $versionLine"
    }

    Push-Location $project
    try {
        git init -q
        $setupLog = Join-Path $work 'setup.log'
        # Setup needs an installed host, and a clean machine has none: a copy of tmb named
        # claude stands in, since setup only needs `claude --version` to answer.
        $fakeHost = Join-Path $work 'fake-host'
        New-Item -ItemType Directory -Force -Path $fakeHost | Out-Null
        Copy-Item $tmb (Join-Path $fakeHost 'claude.exe')
        $savedPath = $env:PATH
        $env:PATH = "$fakeHost;$savedPath"
        try { & $tmb setup *> $setupLog }
        finally { $env:PATH = $savedPath }
        $settings = Join-Path $project '.claude\settings.local.json'
        if ($LASTEXITCODE -eq 0 -and (Test-Path $settings) -and (Get-Content -Raw $settings) -match 'hook session-start') {
            Pass 'tmb setup wired the SessionStart hook in a fresh git repo'
        }
        else {
            Show-Log $setupLog
            Fail 'tmb setup wired the SessionStart hook in a fresh git repo'
        }

        $hookOutput = ('{}' | & $tmb hook session-start | Out-String)
        try {
            $answer = ($hookOutput | ConvertFrom-Json).hookSpecificOutput
            if ($answer.hookEventName -ne 'SessionStart') {
                Fail "tmb hook session-start: hookEventName is '$($answer.hookEventName)', not SessionStart"
            }
            elseif ("$($answer.additionalContext)" -notlike '*You are bro*') {
                Fail 'tmb hook session-start: additionalContext lacks "You are bro"'
            }
            else {
                Pass 'tmb hook session-start answers as bro'
            }
        }
        catch {
            Fail "tmb hook session-start: output is not the hook JSON: $_"
        }
    }
    finally {
        Pop-Location
    }
}

try {
    Invoke-Smoke
}
catch {
    Fail "unexpected error: $_"
}
finally {
    foreach ($name in $saved.Keys) {
        if ($null -eq $saved[$name]) { Remove-Item -Path "env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -Path "env:$name" -Value $saved[$name] }
    }
    Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}

if ($script:failures -eq 0) {
    Write-Host 'install smoke: all checks passed'
    exit 0
}
Write-Host "install smoke: $($script:failures) check(s) failed"
exit 1
