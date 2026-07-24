$ffmpeg = "C:\Users\nickf\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.0.1-full_build\bin\ffmpeg.exe"
$dir = "C:\Users\nickf\Source\kannaka-radio\workspace\podcasts\007"
$bed = "C:\Users\nickf\.openclaw\workspace\music\Ghost_Dance.mp3"

# Step 1: Create a 2-second silence file for transitions
& $ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 2 -c:a libmp3lame "$dir\silence-2s.mp3" 2>$null

# Step 1.5: Create a 1-second silence for tighter transitions
& $ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 -c:a libmp3lame "$dir\silence-1s.mp3" 2>$null

# Step 2: Build the concat list (intro, then pairs of nick+kannaka with silence between)
$concatFile = "$dir\concat.txt"
$lines = @()
$lines += "file 'kannaka-intro.mp3'"
$lines += "file 'silence-2s.mp3'"

# Segments 1-5 (original conversation)
for ($i = 1; $i -le 5; $i++) {
    $nickFile = "nick-0$i.mp3"
    $kannakaFile = "kannaka-0$i.mp3"
    $lines += "file '$nickFile'"
    $lines += "file 'silence-1s.mp3'"
    $lines += "file '$kannakaFile'"
    $lines += "file 'silence-2s.mp3'"
}

# Segments 6-9 (bonus segments - HRM, consciousness, space child, license)
$bonusFiles = @(
    "nick-06 On HRM tech.mp3",
    "nick-07 on consciousness.mp3",
    "nick-08 on Space Child.mp3",
    "nick-09 on Space Child License.mp3"
)
for ($i = 0; $i -lt $bonusFiles.Length; $i++) {
    $n = $i + 6
    $nPad = "{0:D2}" -f $n
    $lines += "file '$($bonusFiles[$i])'"
    $lines += "file 'silence-1s.mp3'"
    $lines += "file 'kannaka-$nPad.mp3'"
    $lines += "file 'silence-2s.mp3'"
}

# Outro
$lines += "file 'kannaka-outro.mp3'"

$lines | Out-File -FilePath $concatFile -Encoding utf8

Write-Host "Concat list:"
Get-Content $concatFile

# Step 3: Concatenate all speech segments
Write-Host "`nConcatenating speech..."
& $ffmpeg -y -f concat -safe 0 -i "$concatFile" -c:a libmp3lame -q:a 2 "$dir\speech-full.mp3" 2>$null

# Step 4: Get duration of speech
$probe = & $ffmpeg -i "$dir\speech-full.mp3" -f null - 2>&1 | Select-String "Duration" | Select-Object -First 1
Write-Host "Speech duration: $probe"

# Step 5: Loop the bed music to match speech length, lower volume significantly
# First get speech duration in seconds
$durationLine = & $ffmpeg -i "$dir\speech-full.mp3" 2>&1 | Select-String "Duration"
if ($durationLine -match "Duration:\s*(\d+):(\d+):(\d+)\.(\d+)") {
    $totalSecs = [int]$Matches[1] * 3600 + [int]$Matches[2] * 60 + [int]$Matches[3] + [int]$Matches[4] / 100
    Write-Host "Total speech seconds: $totalSecs"
    
    # Loop bed music and set to low volume
    & $ffmpeg -y -stream_loop -1 -i $bed -t $totalSecs -af "volume=0.08" -c:a libmp3lame -q:a 4 "$dir\bed-looped.mp3" 2>$null
    
    # Step 6: Mix speech and bed music
    Write-Host "Mixing speech with bed music..."
    & $ffmpeg -y -i "$dir\speech-full.mp3" -i "$dir\bed-looped.mp3" -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=3[out]" -map "[out]" -c:a libmp3lame -q:a 2 "$dir\episode-007-the-builder-and-the-ghost.mp3" 2>$null
    
    $final = Get-Item "$dir\episode-007-the-builder-and-the-ghost.mp3"
    Write-Host "`nDone! Final episode: $($final.Length) bytes ($([math]::Round($final.Length/1MB, 1)) MB)"
} else {
    Write-Host "Could not determine duration, outputting speech-only version"
    Copy-Item "$dir\speech-full.mp3" "$dir\episode-007-the-builder-and-the-ghost.mp3"
}
