param(
    [int]$Port = 8888,
    [string]$MusicDir = ""
)

$workDir = $PSScriptRoot

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    if ($c.OwningProcess -ne 0) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep 1

$nodeArgs = @("server.js", "--port", "$Port")
if ($MusicDir -ne "") {
    $nodeArgs += "--music-dir"
    $nodeArgs += $MusicDir
}

Start-Process -FilePath "node" -ArgumentList $nodeArgs -WorkingDirectory $workDir -WindowStyle Hidden
Start-Sleep 2
Write-Host "Radio restarted on port $Port"
Write-Host "Player: http://localhost:$Port"
