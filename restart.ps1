$conns = Get-NetTCPConnection -LocalPort 8888 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    if ($c.OwningProcess -ne 0) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}
Start-Sleep 1
Start-Process -FilePath "node" -ArgumentList "server.js","--port","8888" -WorkingDirectory "C:\Users\nickf\Source\kannaka-radio" -WindowStyle Hidden
Start-Sleep 2
Write-Host "Radio restarted on port 8888"
