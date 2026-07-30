<#
  ISTV Reel Tool — editor installer (Windows).

  Double-click install.bat (which runs this) to install the Premiere panel:
    1. Enables CEP extensions (PlayerDebugMode) for the CEP versions Premiere
       2021–2025 use.
    2. Copies the bundled extension into Premiere's CEP extensions folder.

  No Node, npm, Python, or Adobe tools required — FFmpeg is already bundled.
  After it finishes: restart Premiere, then Window ▸ Extensions ▸ ISTV Reel Tool.
#>
$ErrorActionPreference = "Stop"
$ExtId = "com.istv.reeltool"

Write-Host ""
Write-Host "  Installing ISTV Reel Tool for Premiere Pro" -ForegroundColor Cyan
Write-Host "  -------------------------------------------"

# 1) Enable unsigned CEP extensions for all relevant CSXS versions.
foreach ($v in 9, 10, 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "  [1/2] CEP extensions enabled." -ForegroundColor Green

# 2) Locate the bundled extension folder (sibling of this script) and copy it in.
$source = Join-Path $PSScriptRoot $ExtId
if (-not (Test-Path $source)) {
  # Dev fallback: this script's parent IS the extension (installer/ lives inside it).
  $source = Split-Path $PSScriptRoot -Parent
}
$destRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $destRoot $ExtId
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }

# Copy everything except installer scripts / build artifacts / VCS metadata.
robocopy $source $dest /E /NFL /NDL /NJH /NJS /NP `
  /XD ".git" "dist" "installer" `
  /XF ".gitignore" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy exit $LASTEXITCODE)" }

Write-Host "  [2/2] Extension copied to:" -ForegroundColor Green
Write-Host "        $dest"
Write-Host ""
Write-Host "  Done. Restart Premiere Pro, then open:" -ForegroundColor Cyan
Write-Host "        Window > Extensions > ISTV Reel Tool"
Write-Host ""
