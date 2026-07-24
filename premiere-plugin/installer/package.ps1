<#
  ISTV Reel Tool — build the shareable package (for YOU, once per release).

  Produces dist/ISTV-Reel-Tool.zip that editors unzip and install by
  double-clicking install.bat. It bundles FFmpeg (npm install) so editors need
  no dev tools.

  Usage:
    ./installer/package.ps1                              # keep current config.json
    ./installer/package.ps1 -BackendUrl "https://reels.insidesuccess.com"

  Pass -BackendUrl to bake your hosted backend into the shared build so editors
  point at it automatically. Omit it to keep whatever config.json already has
  (e.g. localhost for your own testing).
#>
param(
  [string]$BackendUrl = ""
)
$ErrorActionPreference = "Stop"
$ExtId = "com.istv.reeltool"
$root = Split-Path $PSScriptRoot -Parent          # premiere-plugin
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "ISTV-Reel-Tool"
$extDir = Join-Path $stage $ExtId

Write-Host "Packaging ISTV Reel Tool…" -ForegroundColor Cyan

# 1) Bundle FFmpeg.
if (-not (Test-Path (Join-Path $root "node_modules\ffmpeg-static"))) {
  Write-Host "  npm install (bundling FFmpeg)…"
  Push-Location $root
  npm install
  Pop-Location
}

# 2) Optionally bake the hosted backend URL into config.json.
if ($BackendUrl -ne "") {
  $cfgPath = Join-Path $root "config.json"
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $cfg.backendUrl = $BackendUrl.TrimEnd("/")
  ($cfg | ConvertTo-Json -Depth 5) | Set-Content $cfgPath -Encoding utf8
  Write-Host "  Baked backendUrl = $($cfg.backendUrl)" -ForegroundColor Green
}

# 3) Stage the extension (exclude build/dev/VCS cruft; keep node_modules + presets).
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $extDir -Force | Out-Null
robocopy $root $extDir /E /NFL /NDL /NJH /NJS /NP `
  /XD ".git" "dist" "installer" `
  /XF ".gitignore" ".debug" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Staging copy failed (robocopy exit $LASTEXITCODE)" }

# 4) Drop the editor install scripts + a plain-text guide at the top level.
Copy-Item (Join-Path $PSScriptRoot "install.bat")   $stage -Force
Copy-Item (Join-Path $PSScriptRoot "install.ps1")   $stage -Force
Copy-Item (Join-Path $PSScriptRoot "uninstall.bat") $stage -Force
Copy-Item (Join-Path $PSScriptRoot "uninstall.ps1") $stage -Force
Copy-Item (Join-Path $PSScriptRoot "README-EDITORS.txt") $stage -Force

# 5) Zip it.
$zip = Join-Path $dist "ISTV-Reel-Tool.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip
Write-Host ""
Write-Host "Built: $zip" -ForegroundColor Green
Write-Host "Send that zip to editors. They unzip and double-click install.bat."
