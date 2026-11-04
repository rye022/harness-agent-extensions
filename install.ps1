# Installs the Harness Agent Extensions bundles into a DeepSeek Harness profile.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1                 # profile "desktop"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile myprof
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Dsh "C:\path\to\dsh.cmd"
#
# Put this script in the same directory as the three release tarballs:
#   harness-ext-shared-0.1.0.tgz
#   harness-ext-time-machine-0.1.1.tgz
#   harness-ext-context-os-0.1.1.tgz
#
# The script copies the shared tarball into the profile, writes the pnpm override
# that makes @harness-ext/shared resolvable, and adds both plugin tarballs.
# Restart DeepSeek Harness afterwards: bundles are mounted at startup only.

[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$Dsh = '',
    [string]$Source = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Source) {
    $here = $MyInvocation.MyCommand.Path
    if ($here) { $Source = Split-Path -Parent $here }
}
if (-not $Source) { $Source = (Get-Location).Path }

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

function Find-Dsh {
    param([string]$Explicit)
    if ($Explicit) {
        if (-not (Test-Path $Explicit)) { Fail "dsh launcher not found: $Explicit" }
        return (Resolve-Path $Explicit).Path
    }
    $cmd = Get-Command dsh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'),
        'E:\Users\LEGION\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd',
        '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    Fail 'could not find the dsh launcher; pass -Dsh <path to dsh.cmd>'
}

$Dsh = Find-Dsh -Explicit $Dsh
Write-Host "dsh:     $Dsh"

$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path (Join-Path $home_ 'profiles') $Profile
Write-Host "profile: $profileDir"

$shared = Join-Path $Source 'harness-ext-shared-0.1.0.tgz'
$tm = Join-Path $Source 'harness-ext-time-machine-0.1.1.tgz'
$co = Join-Path $Source 'harness-ext-context-os-0.1.1.tgz'
foreach ($file in @($shared, $tm, $co)) {
    if (-not (Test-Path $file)) { Fail "missing tarball: $file" }
}

# Creating the profile is a side effect of any `dsh plugin --profile <name>` call.
if (-not (Test-Path $profileDir)) {
    Write-Host 'seeding profile (first dsh plugin call creates it) ...'
    & $Dsh plugin --profile $Profile list | Out-Null
}
if (-not (Test-Path $profileDir)) { Fail "profile was not created: $profileDir" }

Copy-Item $shared (Join-Path $profileDir 'harness-ext-shared-0.1.0.tgz') -Force
$workspace = Join-Path $profileDir 'pnpm-workspace.yaml'
if (-not (Test-Path $workspace)) { Fail "missing $workspace" }
$yaml = Get-Content $workspace -Raw
if ($yaml -notmatch '@harness-ext/shared') {
    Add-Content -Path $workspace -Value "`noverrides:`n  '@harness-ext/shared': 'file:./harness-ext-shared-0.1.0.tgz'"
    Write-Host 'added the pnpm override for @harness-ext/shared'
} else {
    Write-Host 'pnpm override already present'
}

& $Dsh plugin --profile $Profile add $tm $co
if ($LASTEXITCODE -ne 0) { Fail "dsh plugin add failed with exit code $LASTEXITCODE" }

Write-Host ''
Write-Host 'installed. Quit DeepSeek Harness completely (tray icon too) and start it again.' -ForegroundColor Green
Write-Host 'Check that it works: edit a file through the agent, then look for a new line in'
Write-Host ('  ' + (Join-Path (Join-Path $home_ 'time-machine') 'checkpoints.jsonl'))
Write-Host 'Remove everything again with:'
Write-Host "  dsh plugin --profile $Profile remove @harness-ext/time-machine @harness-ext/context-os"
