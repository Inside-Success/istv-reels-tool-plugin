<#
  ISTV Reel Tool — DEV install (for you, on the machine with the repo).

  Symlinks the live premiere-plugin folder into Premiere's CEP extensions dir so
  your edits appear on the next panel reload — no repackaging while developing.
  Falls back to a copy if symlink creation isn't permitted (needs Admin or
  Windows Developer Mode). Also runs `npm install` if FFmpeg isn't bundled yet.

  Run in PowerShell:  ./installer/dev-install.ps1
#>
$ErrorActionPreference = "Stop"
$ExtId = "com.istv.reeltool"
$root = Split-Path $PSScriptRoot -Parent   # the premiere-plugin folder

# CEP debug flag.
foreach ($v in 9, 10, 11, 12) {
  $key = "HKCU:\Software\Adobe\CSXS.$v"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  New-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -PropertyType String -Force | Out-Null
}
Write-Host "CEP extensions enabled." -ForegroundColor Green

# Bundled FFmpeg present?
if (-not (Test-Path (Join-Path $root "node_modules\ffmpeg-static"))) {
  Write-Host "Installing bundled FFmpeg (npm install)…" -ForegroundColor Cyan
  Push-Location $root
  npm install
  Pop-Location
}

$destRoot = Join-Path $env:APPDATA "Adobe\CEP\extensions"
$dest = Join-Path $destRoot $ExtId
if (-not (Test-Path $destRoot)) { New-Item -ItemType Directory -Path $destRoot -Force | Out-Null }
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }

try {
  New-Item -ItemType SymbolicLink -Path $dest -Target $root | Out-Null
  Write-Host "Symlinked live folder -> $dest" -ForegroundColor Green
} catch {
  Write-Host "Symlink not permitted; copying instead (edits need a re-run)." -ForegroundColor Yellow
  robocopy $root $dest /E /NFL /NDL /NJH /NJS /NP /XD ".git" "dist" | Out-Null
}
Write-Host "Restart Premiere, then Window > Extensions > ISTV Reel Tool." -ForegroundColor Cyan
