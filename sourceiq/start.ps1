# SourceIQ startup script
# Run this once before `npm run dev` each session.

Write-Host "Starting Foundry Local service..." -ForegroundColor Cyan
foundry service start

Write-Host "Loading phi-4-mini model..." -ForegroundColor Cyan
foundry model run phi-4-mini-instruct-openvino-gpu:2

Write-Host ""
Write-Host "Foundry Local ready. Now run: npm run dev" -ForegroundColor Green
