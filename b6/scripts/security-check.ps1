#Requires -Version 5.1
<#
.SYNOPSIS
  Installs Slither (if needed) and runs Dark Questate's security checks, writing everything to reports\.

.DESCRIPTION
  1. Checks Node, pnpm and Python 3.10+.
  2. Installs or updates Slither in a private virtual environment (.venv-slither, git-ignored), so
     nothing is added to your global Python or PATH.
  3. pnpm install --frozen-lockfile.
  4. Recompiles the contracts from scratch (hardhat clean + compile), so Slither reads exactly one
     build of the current sources.
  5. Runs Slither: reports\slither.md (checklist), reports\slither.json, reports\slither.sarif
     (open in VS Code's SARIF viewer), reports\slither.txt (full log). Fails on High findings.
  6. Builds everything, runs the Hardhat, Foundry (if forge is installed), core and web tests, the
     integrity gate and a dependency audit.
  Ends with a PASS/FAIL table, also saved as reports\summary.txt. Each step's output is in
  reports\<step>.log.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\security-check.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\security-check.ps1 -SlitherOnly
#>
[CmdletBinding()]
param(
  # Only install Slither, compile and run Slither.
  [switch]$SlitherOnly,
  # Do not touch the Slither installation (use the one already in .venv-slither).
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Contracts = Join-Path $Root 'packages\contracts'
$Reports = Join-Path $Root 'reports'
$Venv = Join-Path $Root '.venv-slither'
$VenvPython = Join-Path $Venv 'Scripts\python.exe'
$SlitherSpec = 'slither-analyzer>=0.11.3'

New-Item -ItemType Directory -Force -Path $Reports | Out-Null
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$env:PYTHONUTF8 = '1'
$env:HARDHAT_DISABLE_TELEMETRY_PROMPT = 'true'
$env:FORCE_COLOR = '0'

$results = New-Object System.Collections.Specialized.OrderedDictionary

function Write-Step([string]$Name) {
  Write-Host ''
  Write-Host "=== $Name" -ForegroundColor Cyan
}

# Runs a cmd.exe command line (stdout and stderr together), shows it live, saves it to
# reports\<step>.log as UTF-8, and records PASS/FAIL. -Optional steps report WARN instead of FAIL.
# The whole line is wrapped in an extra pair of quotes: cmd /s strips exactly that pair, so quoted
# paths inside it survive.
function Invoke-Step {
  param(
    [Parameter(Mandatory)] [string]$Name,
    [Parameter(Mandatory)] [string]$CommandLine,
    [string]$WorkDir = $Root,
    [switch]$Optional
  )
  Write-Step $Name
  $log = Join-Path $Reports ("{0}.log" -f ($Name -replace '[^A-Za-z0-9_-]', '-'))
  $writer = New-Object System.IO.StreamWriter($log, $false, (New-Object System.Text.UTF8Encoding($false)))
  Push-Location $WorkDir
  try {
    Write-Host "> $CommandLine" -ForegroundColor DarkGray
    & cmd.exe /d /s /c ('"(' + $CommandLine + ') 2>&1"') | ForEach-Object {
      $writer.WriteLine($_)
      Write-Host $_
    }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $writer.Close()
  }
  $leaf = Split-Path -Leaf $log
  if ($code -eq 0) {
    $results[$Name] = 'PASS'
  } elseif ($Optional) {
    $results[$Name] = "WARN (exit $code, see reports\$leaf)"
  } else {
    $results[$Name] = "FAIL (exit $code, see reports\$leaf)"
  }
}

function Find-Python {
  $candidates = @(@('py', '-3'), @('python'), @('python3'))
  foreach ($c in $candidates) {
    $exe = $c[0]
    $rest = @($c | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    & $exe @rest -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null
    if ($LASTEXITCODE -eq 0) { return , $c }
  }
  return $null
}

# ---------------------------------------------------------------------------- tools
Write-Step 'tools'
$missing = @()
foreach ($tool in @('node', 'pnpm')) {
  if (Get-Command $tool -ErrorAction SilentlyContinue) {
    Write-Host ("{0,-6} {1}" -f $tool, (& $tool --version))
  } else {
    $missing += $tool
  }
}
$python = Find-Python
if ($python) {
  Write-Host ("python {0}" -f (& $python[0] @(@($python | Select-Object -Skip 1) + '--version')))
} else {
  $missing += 'python 3.10+'
}
$haveForge = [bool](Get-Command forge -ErrorAction SilentlyContinue)
Write-Host ("forge  {0}" -f $(if ($haveForge) { (& forge --version | Select-Object -First 1) } else { 'not installed (Foundry suites will be skipped)' }))
if ($missing.Count -gt 0) {
  Write-Host ''
  Write-Host ("Missing: {0}" -f ($missing -join ', ')) -ForegroundColor Red
  Write-Host 'Install Node 22 (https://nodejs.org), pnpm (corepack enable), and Python 3.12 (winget install Python.Python.3.12), then run this again.'
  exit 2
}
$results['tools'] = 'PASS'

# ---------------------------------------------------------------------------- slither install
if (-not $SkipInstall) {
  Write-Step 'install slither'
  if (-not (Test-Path $VenvPython)) {
    Write-Host "Creating $Venv"
    & $python[0] @(@($python | Select-Object -Skip 1) + @('-m', 'venv', $Venv))
  }
  if (Test-Path $VenvPython) {
    & $VenvPython -m pip install --disable-pip-version-check --quiet --upgrade pip
    & $VenvPython -m pip install --disable-pip-version-check --upgrade $SlitherSpec
    $results['install slither'] = $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { "FAIL (pip exit $LASTEXITCODE)" })
  } else {
    $results['install slither'] = 'FAIL (could not create the virtual environment)'
  }
}
if (Test-Path $VenvPython) {
  Write-Host ("slither {0}" -f (& $VenvPython -m slither --version))
}

# ---------------------------------------------------------------------------- build
Invoke-Step -Name 'pnpm install' -CommandLine 'call pnpm install --frozen-lockfile'
# One clean build of the current sources: stale build-info files would make Slither analyse old code.
Invoke-Step -Name 'compile contracts' -WorkDir $Contracts -CommandLine 'call pnpm exec hardhat clean && call pnpm exec hardhat compile'

# ---------------------------------------------------------------------------- slither
if ((Test-Path $VenvPython) -and $results['compile contracts'] -eq 'PASS') {
  foreach ($f in @('slither.json', 'slither.sarif', 'slither.md', 'slither.txt')) {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Reports $f)
  }
  Write-Step 'slither'
  Push-Location $Contracts
  try {
    $cmd = '"{0}" -m slither . --config-file slither.config.json --fail-on high --json "{1}" --sarif "{2}" --checklist > "{3}" 2> "{4}"' -f `
      $VenvPython, (Join-Path $Reports 'slither.json'), (Join-Path $Reports 'slither.sarif'), (Join-Path $Reports 'slither.md'), (Join-Path $Reports 'slither.txt')
    Write-Host "> $cmd" -ForegroundColor DarkGray
    & cmd.exe /d /s /c ('"' + $cmd + '"')
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  Get-Content (Join-Path $Reports 'slither.txt') -ErrorAction SilentlyContinue | Select-Object -Last 40
  $results['slither'] = $(if ($code -eq 0) { 'PASS (no High findings)' } else { "FAIL (exit $code, see reports\slither.md and slither.txt)" })
} else {
  $results['slither'] = 'SKIP (no Slither install or the compile failed)'
}

# ---------------------------------------------------------------------------- everything else
if (-not $SlitherOnly) {
  Invoke-Step -Name 'build' -CommandLine 'call pnpm build'
  Invoke-Step -Name 'test' -CommandLine 'call pnpm test'
  if ($haveForge) {
    Invoke-Step -Name 'forge test' -WorkDir $Contracts -CommandLine 'forge test'
    Invoke-Step -Name 'forge lint' -WorkDir $Contracts -CommandLine 'forge lint --deny warnings' -Optional
  } else {
    $results['forge test'] = 'SKIP (forge not installed: https://getfoundry.sh)'
  }
  Invoke-Step -Name 'integrity' -CommandLine 'call pnpm integrity'
  Invoke-Step -Name 'dependency audit' -CommandLine 'call pnpm audit --audit-level high' -Optional
}

# ---------------------------------------------------------------------------- summary
$lines = @('Dark Questate security check, ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'), '')
foreach ($k in $results.Keys) { $lines += ('{0,-20} {1}' -f $k, $results[$k]) }
$summary = Join-Path $Reports 'summary.txt'
$lines | Set-Content -Path $summary -Encoding UTF8
Write-Host ''
Write-Host '=== summary' -ForegroundColor Cyan
foreach ($l in $lines) {
  $color = if ($l -match '\bFAIL\b') { 'Red' } elseif ($l -match '\b(WARN|SKIP)\b') { 'Yellow' } else { 'Gray' }
  Write-Host $l -ForegroundColor $color
}
Write-Host ''
Write-Host "Reports: $Reports"
$failed = @($results.Values | Where-Object { $_ -like 'FAIL*' }).Count
exit $(if ($failed -gt 0) { 1 } else { 0 })
