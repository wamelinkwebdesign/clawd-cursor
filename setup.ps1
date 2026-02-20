<#
.SYNOPSIS
    Clawd Cursor setup script for Windows — installs TightVNC + dependencies
.DESCRIPTION
    Downloads and installs TightVNC Server silently, then sets up Clawd Cursor.
    Run as Administrator for TightVNC installation.
#>

param(
    [string]$VncPassword = "",
    [switch]$SkipVnc,
    [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "  🐾 Clawd Cursor — Setup Script" -ForegroundColor Cyan
Write-Host "  ================================" -ForegroundColor DarkCyan
Write-Host ""

# ─── Check Admin ───────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipVnc) {
    Write-Host "  ⚠️  Not running as Administrator. VNC installation may fail." -ForegroundColor Yellow
    Write-Host "  Tip: Right-click PowerShell → Run as Administrator" -ForegroundColor Gray
    Write-Host ""
}

# ─── Check Node.js ─────────────────────────────────────────────
Write-Host "  [1/4] Checking Node.js..." -ForegroundColor White
try {
    $nodeVersion = (node --version 2>$null)
    if ($nodeVersion) {
        $major = [int]($nodeVersion -replace 'v(\d+).*', '$1')
        if ($major -ge 20) {
            Write-Host "    ✅ Node.js $nodeVersion" -ForegroundColor Green
        } else {
            Write-Host "    ❌ Node.js $nodeVersion found but need v20+." -ForegroundColor Red
            Write-Host "    Download: https://nodejs.org/" -ForegroundColor Gray
            if (-not $SkipNode) { exit 1 }
        }
    } else {
        throw "not found"
    }
} catch {
    Write-Host "    ❌ Node.js not found." -ForegroundColor Red
    Write-Host "    Download: https://nodejs.org/ (LTS recommended)" -ForegroundColor Gray
    if (-not $SkipNode) { exit 1 }
}

# ─── Check/Install TightVNC ───────────────────────────────────
Write-Host "  [2/4] Checking VNC Server..." -ForegroundColor White

$vncInstalled = $false
$tightVncPath = "C:\Program Files\TightVNC"
$tightVncService = Get-Service -Name "tvnserver" -ErrorAction SilentlyContinue

if ($tightVncService -or (Test-Path "$tightVncPath\tvnserver.exe")) {
    Write-Host "    ✅ TightVNC already installed" -ForegroundColor Green
    $vncInstalled = $true
} elseif (-not $SkipVnc) {
    Write-Host "    📥 Downloading TightVNC..." -ForegroundColor Yellow
    
    $tightVncUrl = "https://www.tightvnc.com/download/2.8.85/tightvnc-2.8.85-gpl-setup-64bit.msi"
    $installerPath = "$env:TEMP\tightvnc-setup.msi"
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $tightVncUrl -OutFile $installerPath -UseBasicParsing
        Write-Host "    📦 Installing TightVNC Server..." -ForegroundColor Yellow
        
        # Prompt for VNC password if not provided
        if (-not $VncPassword) {
            $securePass = Read-Host "    Enter VNC password (min 6 chars)" -AsSecureString
            $VncPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
            )
        }
        
        if ($VncPassword.Length -lt 6) {
            Write-Host "    ❌ Password must be at least 6 characters." -ForegroundColor Red
            exit 1
        }
        
        # Silent install — server only (no viewer needed)
        $msiArgs = @(
            "/i", $installerPath,
            "/quiet", "/norestart",
            "ADDLOCAL=Server",
            "SERVER_REGISTER_AS_SERVICE=1",
            "SERVER_ADD_FIREWALL_EXCEPTION=1",
            "SET_USEVNCAUTHENTICATION=1",
            "VALUE_OF_USEVNCAUTHENTICATION=1",
            "SET_PASSWORD=1",
            "VALUE_OF_PASSWORD=$VncPassword"
        )
        
        Start-Process "msiexec.exe" -ArgumentList $msiArgs -Wait -NoNewWindow
        
        # Verify installation
        Start-Sleep -Seconds 2
        if (Test-Path "$tightVncPath\tvnserver.exe") {
            Write-Host "    ✅ TightVNC installed successfully" -ForegroundColor Green
            $vncInstalled = $true
            
            # Start the service if not running
            $svc = Get-Service -Name "tvnserver" -ErrorAction SilentlyContinue
            if ($svc -and $svc.Status -ne 'Running') {
                Start-Service -Name "tvnserver"
                Write-Host "    ✅ VNC Server started" -ForegroundColor Green
            }
        } else {
            Write-Host "    ⚠️  Installation may have failed. Try installing TightVNC manually." -ForegroundColor Yellow
            Write-Host "    Download: https://www.tightvnc.com/download.php" -ForegroundColor Gray
        }
        
        # Cleanup
        Remove-Item $installerPath -ErrorAction SilentlyContinue
    } catch {
        Write-Host "    ⚠️  Download failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "    Install TightVNC manually: https://www.tightvnc.com/download.php" -ForegroundColor Gray
    }
} else {
    Write-Host "    ⏭️  Skipped (--SkipVnc)" -ForegroundColor Gray
}

# ─── Install npm dependencies ─────────────────────────────────
Write-Host "  [3/4] Installing dependencies..." -ForegroundColor White
try {
    npm install --loglevel=error 2>$null
    Write-Host "    ✅ Dependencies installed" -ForegroundColor Green
} catch {
    Write-Host "    ❌ npm install failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ─── Build TypeScript ──────────────────────────────────────────
Write-Host "  [4/4] Building TypeScript..." -ForegroundColor White
try {
    npm run build 2>$null
    Write-Host "    ✅ Build complete" -ForegroundColor Green
} catch {
    Write-Host "    ❌ Build failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ─── Done ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ✅ Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env" -ErrorAction SilentlyContinue
    Write-Host "    1. Edit .env and add your AI_API_KEY" -ForegroundColor Gray
} else {
    Write-Host "    1. Make sure .env has your AI_API_KEY" -ForegroundColor Gray
}

if ($VncPassword) {
    Write-Host "    2. Run: npm start -- --vnc-password $VncPassword" -ForegroundColor Cyan
} else {
    Write-Host "    2. Run: npm start -- --vnc-password <your-vnc-password>" -ForegroundColor Cyan
}
Write-Host ""
Write-Host "  🐾 Happy clawing!" -ForegroundColor Cyan
Write-Host ""
