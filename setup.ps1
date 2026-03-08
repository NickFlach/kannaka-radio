# Kannaka Radio - Music Setup Script
# Copies the Consciousness Series tracks from your local music collection
# into the project's music/ directory.
#
# Usage:
#   .\setup.ps1
#   .\setup.ps1 -SourceDir "C:\Users\yourname\Music"
#   .\setup.ps1 -SourceDir "D:\Music" -Force

param(
    [string]$SourceDir = "C:\Users\nickf\Downloads\Music",
    [switch]$Force
)

$dest = Join-Path $PSScriptRoot "music"
$exts = @(".mp3", ".wav", ".flac", ".m4a", ".ogg")

Write-Host ""
Write-Host "Kannaka Radio - Music Setup" -ForegroundColor Magenta
Write-Host "  Source:      $SourceDir"
Write-Host "  Destination: $dest"
Write-Host ""

if (-not (Test-Path $SourceDir)) {
    Write-Host "Source directory not found: $SourceDir" -ForegroundColor Red
    Write-Host "Run with -SourceDir to specify your music folder:" -ForegroundColor Yellow
    Write-Host "  .\setup.ps1 -SourceDir C:\path\to\your\music" -ForegroundColor Yellow
    exit 1
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null

$sourceFiles = Get-ChildItem -Path $SourceDir -File | Where-Object {
    $exts -contains $_.Extension.ToLower()
}

if ($sourceFiles.Count -eq 0) {
    Write-Host "No audio files found in: $SourceDir" -ForegroundColor Red
    exit 1
}

Write-Host "Found $($sourceFiles.Count) audio files in source." -ForegroundColor Cyan
Write-Host ""

$copied  = 0
$skipped = 0
$errors  = 0

foreach ($file in $sourceFiles) {
    $destFile = Join-Path $dest $file.Name
    $alreadyExists = Test-Path $destFile
    if ($alreadyExists -and (-not $Force)) {
        $skipped++
    } else {
        Copy-Item -Path $file.FullName -Destination $destFile -Force -ErrorAction SilentlyContinue
        if ($?) {
            Write-Host "  + $($file.Name)" -ForegroundColor Green
            $copied++
        } else {
            Write-Host "  ! $($file.Name) - copy failed" -ForegroundColor Red
            $errors++
        }
    }
}

$destCount = (Get-ChildItem -Path $dest -File | Where-Object { $exts -contains $_.Extension.ToLower() }).Count

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
Write-Host "  Copied:  $copied"
Write-Host "  Skipped: $skipped"
if ($errors -gt 0) {
    Write-Host "  Errors:  $errors" -ForegroundColor Red
}
Write-Host ""
Write-Host "Music library: $destCount tracks in $dest" -ForegroundColor Magenta
Write-Host ""
Write-Host "Start the radio:"
Write-Host "  node server.js" -ForegroundColor Cyan
Write-Host ""
