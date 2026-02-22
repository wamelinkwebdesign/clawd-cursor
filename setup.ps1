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
Write-Host "  [*] Clawd Cursor — Setup Script" -ForegroundColor Cyan
Write-Host "  ================================" -ForegroundColor DarkCyan
Write-Host ""

# ─── Check Admin ───────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $SkipVnc) {
    Write-Host "  [WARN]  Not running as Administrator. VNC installation may fail." -ForegroundColor Yellow
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
            Write-Host "    [OK] Node.js $nodeVersion" -ForegroundColor Green
        } else {
            Write-Host "    [FAIL] Node.js $nodeVersion found but need v20+." -ForegroundColor Red
            Write-Host "    Download: https://nodejs.org/" -ForegroundColor Gray
            if (-not $SkipNode) { exit 1 }
        }
    } else {
        throw "not found"
    }
} catch {
    Write-Host "    [FAIL] Node.js not found." -ForegroundColor Red
    Write-Host "    Download: https://nodejs.org/ (LTS recommended)" -ForegroundColor Gray
    if (-not $SkipNode) { exit 1 }
}

# ─── Check/Install TightVNC ───────────────────────────────────
Write-Host "  [2/4] Checking VNC Server..." -ForegroundColor White

$vncInstalled = $false
$tightVncPath = "C:\Program Files\TightVNC"
$tightVncService = Get-Service -Name "tvnserver" -ErrorAction SilentlyContinue

if ($tightVncService -or (Test-Path "$tightVncPath\tvnserver.exe")) {
    Write-Host "    [OK] TightVNC already installed" -ForegroundColor Green
    $vncInstalled = $true
} elseif (-not $SkipVnc) {
    # Check if running as Administrator for TightVNC installation
    $isAdminForVnc = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    
    if (-not $isAdminForVnc) {
        Write-Host "    [WARN]  Administrator privileges required to install TightVNC." -ForegroundColor Yellow
        Write-Host "" -ForegroundColor White
        Write-Host "    To install TightVNC manually, run this command as Administrator:" -ForegroundColor White
        Write-Host "" -ForegroundColor Gray
        Write-Host "    msiexec /i https://www.tightvnc.com/download/2.8.85/tightvnc-2.8.85-gpl-setup-64bit.msi /quiet /norestart ADDLOCAL=Server SERVER_REGISTER_AS_SERVICE=1 SERVER_ADD_FIREWALL_EXCEPTION=1 SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 SET_PASSWORD=1 VALUE_OF_PASSWORD=YOUR_PASSWORD" -ForegroundColor Cyan
        Write-Host "" -ForegroundColor Gray
        Write-Host "    Continuing with the rest of setup..." -ForegroundColor Gray
        Write-Host ""
    } else {
    Write-Host "    [DL] Downloading TightVNC..." -ForegroundColor Yellow
    
    $tightVncUrl = "https://www.tightvnc.com/download/2.8.85/tightvnc-2.8.85-gpl-setup-64bit.msi"
    $installerPath = "$env:TEMP\tightvnc-setup.msi"
    
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $tightVncUrl -OutFile $installerPath -UseBasicParsing
        Write-Host "    [PKG] Installing TightVNC Server..." -ForegroundColor Yellow
        
        # Prompt for VNC password if not provided
        if (-not $VncPassword) {
            # Check if running interactively
            $isInteractive = [Environment]::UserInteractive -and (-not ([Environment]::GetCommandLineArgs() -match '-NonInteractive'))
            if ($isInteractive) {
                $securePass = Read-Host "    Enter VNC password (min 6 chars)" -AsSecureString
                $VncPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
                    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
                )
            }
        }
        
        if (-not $VncPassword -or $VncPassword.Length -lt 6) {
            # Generate a random password so the script can continue
            $VncPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 12 | ForEach-Object {[char]$_})
            Write-Host "    [KEY] No password provided — generated: $VncPassword" -ForegroundColor Cyan
            Write-Host "    Save this! You'll need it to start the agent." -ForegroundColor Yellow
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
        
        try {
            $proc = Start-Process "msiexec.exe" -ArgumentList $msiArgs -PassThru -WindowStyle Hidden
            $proc.WaitForExit()
            if ($proc.ExitCode -ne 0) {
                Write-Host "    [WARN]  TightVNC installer exited with code $($proc.ExitCode), continuing..." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "    [WARN]  VNC install failed: $($_.Exception.Message). Continuing..." -ForegroundColor Yellow
        }
        
        # Verify installation
        Start-Sleep -Seconds 3
        if (Test-Path "$tightVncPath\tvnserver.exe") {
            Write-Host "    [OK] TightVNC installed successfully" -ForegroundColor Green
            $vncInstalled = $true
            
            # Start the service if not running — wrapped to prevent crash
            try {
                $svc = Get-Service -Name "tvnserver" -ErrorAction SilentlyContinue
                if ($svc -and $svc.Status -ne 'Running') {
                    Start-Service -Name "tvnserver" -ErrorAction Stop
                    Start-Sleep -Seconds 2
                    Write-Host "    [OK] VNC Server started" -ForegroundColor Green
                } elseif ($svc) {
                    Write-Host "    [OK] VNC Server already running" -ForegroundColor Green
                }
            } catch {
                Write-Host "    [WARN] Could not start VNC service: $($_.Exception.Message)" -ForegroundColor Yellow
                Write-Host "    Start it manually: net start tvnserver" -ForegroundColor Gray
            }
        } else {
            Write-Host "    [WARN] Installation may have failed. Try installing TightVNC manually." -ForegroundColor Yellow
            Write-Host "    Download: https://www.tightvnc.com/download.php" -ForegroundColor Gray
        }
        
        # Cleanup
        Remove-Item $installerPath -ErrorAction SilentlyContinue
    } catch {
        Write-Host "    [WARN]  Download failed: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "    Install TightVNC manually: https://www.tightvnc.com/download.php" -ForegroundColor Gray
    }
    }  # Close admin check block
} else {
    Write-Host "    [SKIP]  Skipped (--SkipVnc)" -ForegroundColor Gray
}

# ─── Install npm dependencies ─────────────────────────────────
Write-Host "  [3/4] Installing dependencies..." -ForegroundColor White
try {
    npm install --loglevel=error 2>$null
    Write-Host "    [OK] Dependencies installed" -ForegroundColor Green
} catch {
    Write-Host "    [FAIL] npm install failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ─── Build TypeScript ──────────────────────────────────────────
Write-Host "  [4/4] Building TypeScript..." -ForegroundColor White
try {
    npm run build 2>$null
    Write-Host "    [OK] Build complete" -ForegroundColor Green
} catch {
    Write-Host "    [FAIL] Build failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# ─── Auto-generate VNC password if needed ──────────────────────
if (-not $VncPassword) {
    $VncPassword = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 12 | ForEach-Object {[char]$_})
    Write-Host "  [KEY] Generated VNC password: $VncPassword" -ForegroundColor Cyan
}

# ─── Write .env automatically ──────────────────────────────────
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env" -ErrorAction SilentlyContinue
}

if (Test-Path ".env") {
    $envContent = Get-Content ".env" -Raw
    if ($envContent -match 'VNC_PASSWORD=your_vnc_password|VNC_PASSWORD=$') {
        $envContent = $envContent -replace 'VNC_PASSWORD=your_vnc_password', "VNC_PASSWORD=$VncPassword"
        $envContent = $envContent -replace 'VNC_PASSWORD=$', "VNC_PASSWORD=$VncPassword"
        Set-Content ".env" $envContent -NoNewline
        Write-Host "  [OK] VNC password written to .env" -ForegroundColor Green
    } elseif ($envContent -notmatch 'VNC_PASSWORD=') {
        Add-Content ".env" "`nVNC_PASSWORD=$VncPassword"
        Write-Host "  [OK] VNC password added to .env" -ForegroundColor Green
    } else {
        Write-Host "  [OK] .env already has a VNC password" -ForegroundColor Green
    }
} else {
    Set-Content ".env" "VNC_PASSWORD=$VncPassword`nAI_API_KEY=your_api_key_here`n"
    Write-Host "  [OK] Created .env with VNC password" -ForegroundColor Green
}

# ─── Done ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  [OK] Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor White
Write-Host "    1. Edit .env and add your AI_API_KEY (if not already set)" -ForegroundColor Gray
Write-Host "    2. Run: npm start" -ForegroundColor Cyan
Write-Host ""
Write-Host "  VNC password is auto-configured — no need to pass it manually." -ForegroundColor Gray
Write-Host ""
Write-Host "  [*] Happy clawing!" -ForegroundColor Cyan
Write-Host ""
