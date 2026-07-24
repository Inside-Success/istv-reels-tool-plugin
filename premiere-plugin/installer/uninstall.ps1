<#
  ISTV Reel Tool — uninstaller (Windows). Removes the extension folder from
  Premiere's CEP extensions directory. Leaves the CEP debug flag in place (it is
  harmless and other extensions may rely on it).
#>
$ErrorActionPreference = "Stop"
$ExtId = "com.istv.reeltool"
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\$ExtId"
if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
  Write-Host "  Removed $dest" -ForegroundColor Green
} else {
  Write-Host "  Nothing to remove ($dest not found)." -ForegroundColor Yellow
}
Write-Host "  Restart Premiere Pro to complete removal."
