<#
  ISTV Reel Tool — editor installer (Windows x64).

  Double-click install.bat (which runs this). It:
    1. enables unsigned CEP extensions (HKCU\Software\Adobe\CSXS.N\PlayerDebugMode)
    2. copies the panel into %APPDATA%\Adobe\CEP\extensions
    3. confirms the bundled FFmpeg matches this machine's platform

  No Node, npm, Python, or Adobe tools required, and no admin rights — everything
  lands in the current user's AppData. The macOS equivalent is install.command.

  After it finishes: restart Premiere, then Window > Extensions > ISTV Reel Tool.
#>
$ErrorActionPreference = "Stop"
$ExtId = "com.istv.reeltool"
$Target = "win32-x64"

Write-Host ""
Write-Host "  Installing ISTV Reel Tool for Premiere Pro" -ForegroundColor Cyan
Write-Host "  -------------------------------------------"

# --- 0) Locate the extension payload -----------------------------------------
# In a release bundle the payload sits next to this script. The dev fallback is for
# running installer\install.ps1 straight out of the repo.
$source = Join-Path $PSScriptRoot $ExtId
if (-not (Test-Path $source)) {
  $source = Split-Path $PSScriptRoot -Parent
}
if (-not (Test-Path (Join-Path $source "CSXS\manifest.xml"))) {
  Write-Host ""
  Write-Host "  ERROR: could not find the extension payload." -ForegroundColor Red
  Write-Host "  Expected $source\CSXS\manifest.xml"
  Write-Host "  Re-unzip the package and keep install.bat next to the $ExtId folder."
  exit 1
}

# --- 1) Allow unsigned extensions to load ------------------------------------
# CSXS 9-12 covers Premiere 2019 through 2025; a superset is harmless.
foreach ($v in 9, 10, 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "  [1/3] CEP extensions enabled." -ForegroundColor Green

# --- 2) Copy the panel in ----------------------------------------------------
$destRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $destRoot $ExtId
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }

# Exclusions matter only for the dev fallback above; a release payload is already clean.
robocopy $source $dest /E /NFL /NDL /NJH /NJS /NP `
  /XD ".git" "dist" "installer" "tools" "test" "node_modules" `
  /XF ".gitignore" ".debug" "package-lock.json" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE)" }

Write-Host "  [2/3] Panel copied to:" -ForegroundColor Green
Write-Host "        $dest"

# --- 3) Confirm the bundled FFmpeg is the right platform ---------------------
# A bundle built for macOS would install fine and then fail at "Extract audio",
# so say so now rather than letting the editor discover it mid-run.
$ffmpeg = Join-Path $dest "vendor\ffmpeg\$Target\ffmpeg.exe"
if (Test-Path $ffmpeg) {
  Write-Host "  [3/3] Bundled FFmpeg ready for $Target." -ForegroundColor Green
} else {
  Write-Host "  [3/3] WARNING: no bundled FFmpeg found for $Target." -ForegroundColor Yellow
  Write-Host "        This package may have been built for a different platform."
  Write-Host "        The panel will fall back to an ffmpeg on your PATH if you have one."
}

Write-Host ""
Write-Host "  Done. Restart Premiere Pro, then open:" -ForegroundColor Cyan
Write-Host "        Window > Extensions > ISTV Reel Tool"
Write-Host ""
Write-Host "  To remove it later: double-click uninstall.bat"
Write-Host ""
