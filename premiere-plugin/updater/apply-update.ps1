param(
  [Parameter(Mandatory=$true)][string]$Zip,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$Label
)
$ErrorActionPreference = 'Stop'
$work = Split-Path $Zip -Parent
$status = Join-Path $work 'status.txt'
$log = Join-Path $work 'update.log'
try {
  for ($i = 0; $i -lt 600; $i++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw 'Premiere was not closed within 10 minutes.'
  }
  $expanded = Join-Path $work 'expanded'
  if (Test-Path $expanded) { Remove-Item $expanded -Recurse -Force }
  Expand-Archive -LiteralPath $Zip -DestinationPath $expanded -Force
  $source = Join-Path $expanded "ISTV-Reel-Tool-$Label\com.istv.reeltool"
  if (-not (Test-Path (Join-Path $source 'CSXS\manifest.xml')) -or
      -not (Test-Path (Join-Path $source 'js\main.js'))) {
    throw 'The release ZIP has no Premiere extension.'
  }
  $backup = Join-Path $work 'previous-extension'
  if (Test-Path $backup) { Remove-Item $backup -Recurse -Force }
  if (Test-Path $Destination) { Move-Item -LiteralPath $Destination -Destination $backup }
  try {
    Copy-Item -LiteralPath $source -Destination $Destination -Recurse -Force
  } catch {
    if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
    if (Test-Path $backup) { Move-Item -LiteralPath $backup -Destination $Destination }
    throw 'Could not copy the new extension; the previous version was restored.'
  }
  Set-Content -LiteralPath $status -Value 'Update installed. Reopen Premiere Pro.'
} catch {
  Set-Content -LiteralPath $log -Value $_.Exception.ToString()
  Set-Content -LiteralPath $status -Value ("Update failed: " + $_.Exception.Message)
  exit 1
}
