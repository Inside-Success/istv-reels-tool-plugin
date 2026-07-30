<#
  ISTV Reel Tool - build the shareable packages (for YOU, once per release).

  This is a thin wrapper around tools/build.mjs, which is the single source of
  truth for packaging. It used to be a second, divergent implementation: it
  bundled node_modules instead of vendor/, produced only a Windows bundle, and
  could only run on Windows. Keeping two builders meant a release could be cut
  either way and get different contents, so this now just forwards.

  Usage:
    ./installer/package.ps1 -BackendUrl "https://istv-reels-tool-plugin.onrender.com"
    ./installer/package.ps1 -BackendUrl "https://..." -Targets win32-x64
    ./installer/package.ps1 -AllowLocalhost          # dev/test bundle only

  Output (one zip per platform, in dist/):
    ISTV-Reel-Tool-win-x64.zip     -> install.bat
    ISTV-Reel-Tool-mac-arm64.zip   -> install.command  (Apple Silicon)
    ISTV-Reel-Tool-mac-x64.zip     -> install.command  (Intel)

  The access token is NEVER baked in - editors enter it once in the panel. See
  README.md (Access token).
#>
param(
  [string]$BackendUrl = "",
  # Comma-separated: win32-x64, darwin-arm64, darwin-x64. Omit to build all three.
  [string]$Targets = "",
  [switch]$AllowLocalhost,
  # One zip carrying every platform's binaries instead of one zip per platform.
  [switch]$Universal
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent          # premiere-plugin

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 18+ is required to build the packages (tools/build.mjs). Install it from https://nodejs.org/"
}

$buildArgs = @()
if ($BackendUrl -ne "")  { $buildArgs += @("--backend-url", $BackendUrl) }
if ($Targets -ne "")     { $buildArgs += @("--targets", $Targets) }
if ($AllowLocalhost)     { $buildArgs += "--allow-localhost" }
if ($Universal)          { $buildArgs += "--universal" }

Push-Location $root
try {
  & node "tools/build.mjs" @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "build.mjs failed (exit $LASTEXITCODE)" }
}
finally {
  Pop-Location
}

exit 0
