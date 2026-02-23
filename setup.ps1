<#
.SYNOPSIS
    Clawd Cursor setup script for Windows — installs dependencies and builds.
.DESCRIPTION
    Sets up Clawd Cursor: installs npm dependencies, builds TypeScript, creates .env.
#>

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "    Clawd Cursor v0.4.0 Setup" -ForegroundColor Cyan
Write-Host "    AI Desktop Agent - Native Control" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
Write-Host "  [1/3] Checking Node.js..." -ForegroundColor White
try {
    $nodeVersion = node --version 2>$null
    if ($nodeVersion) {
        Write-Host "    [OK] Node.js $nodeVersion" -ForegroundColor Green
    } else {
        throw "not found"
    }
} catch {
    Write-Host "    [ERR] Node.js not found. Install from https://nodejs.org (v20+)" -ForegroundColor Red
    exit 1
}

# Install dependencies and build
Write-Host "  [2/3] Installing dependencies..." -ForegroundColor White
npm install 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "    [OK] Dependencies installed" -ForegroundColor Green
} else {
    Write-Host "    [ERR] npm install failed" -ForegroundColor Red
    exit 1
}

Write-Host "  [3/3] Building TypeScript..." -ForegroundColor White
npm run build 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "    [OK] Build complete" -ForegroundColor Green
} else {
    Write-Host "    [ERR] Build failed" -ForegroundColor Red
    exit 1
}

# Create .env if needed
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host ""
    Write-Host "  [!] Created .env — edit it to add your AI_API_KEY" -ForegroundColor Yellow
} else {
    Write-Host "  [OK] .env already exists" -ForegroundColor Green
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "    Setup complete!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "    1. Edit .env and set AI_API_KEY" -ForegroundColor Gray
Write-Host "    2. npm start" -ForegroundColor Gray
Write-Host ""
