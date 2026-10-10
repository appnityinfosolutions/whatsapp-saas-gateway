$env:Path = "C:\Program Files\nodejs;C:\Users\asus\AppData\Local\Programs\nodejs;C:\Users\asus\AppData\Local\Programs\git\cmd;" + $env:Path
Write-Host "Starting WhatsApp SaaS Platform with Node $(node -v)..." -ForegroundColor Green
npm.cmd run dev
