# ============================================================================
# Aether File Indexing Service - Windows Task Setup Script
# ============================================================================
# This script installs the file indexing service as a Windows Scheduled Task
# that runs automatically on user login and survives system restarts.

$ErrorActionPreference = "Stop"

# Service configuration
$TASK_NAME = "AetherFileIndexing"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$BACKEND_DIR = Resolve-Path "$SCRIPT_DIR\..\..\.."
$LOG_DIR = "$BACKEND_DIR\logs"

Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║      Aether File Indexing Service - Windows Task Setup       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ============================================================================
# Pre-flight Checks
# ============================================================================

Write-Host "→ Running pre-flight checks..." -ForegroundColor Yellow

# Check for environment variables
$LOCAL_ENV = "$BACKEND_DIR\config\local.env"
if (Test-Path $LOCAL_ENV) {
    Write-Host "✓ Found environment file: $LOCAL_ENV" -ForegroundColor Green
    $EnvContent = Get-Content $LOCAL_ENV
    foreach ($line in $EnvContent) {
        if ($line -match "^SUPABASE_URL=(.*)") { $env:SUPABASE_URL = $Matches[1] }
        if ($line -match "^SUPABASE_SERVICE_ROLE_KEY=(.*)") { $env:SUPABASE_SERVICE_ROLE_KEY = $Matches[1] }
    }
}

if (-not $env:SUPABASE_URL -or -not $env:SUPABASE_SERVICE_ROLE_KEY) {
    Write-Host "⚠  Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not found in environment." -ForegroundColor Yellow
    Write-Host "   Service may fail to start if not configured elsewhere." -ForegroundColor Yellow
}

# Check if running as a packaged binary or from source
$BACKEND_BIN = "$BACKEND_DIR\aether-hub.exe"
$MAIN_PY = "$BACKEND_DIR\main.py"
$PYTHON_EXE = (Get-Command python.exe -ErrorAction SilentlyContinue).Source

if (Test-Path $BACKEND_BIN) {
    $CMD = "`"$BACKEND_BIN`" aether_rag-daemon"
    Write-Host "✓ Found packaged binary: $BACKEND_BIN" -ForegroundColor Green
} elseif (Test-Path $MAIN_PY) {
    if (-not $PYTHON_EXE) {
        Write-Host "✗ Python not found. Please install Python 3." -ForegroundColor Red
        exit 1
    }
    $CMD = "`"$PYTHON_EXE`" `"$MAIN_PY`" aether_rag-daemon"
    Write-Host "✓ Found source: $MAIN_PY (using $PYTHON_EXE)" -ForegroundColor Green
} else {
    Write-Host "✗ Neither aether-hub.exe nor main.py found in $BACKEND_DIR" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR | Out-Null
}

# ============================================================================
# Install Task
# ============================================================================

Write-Host ""
Write-Host "→ Installing Scheduled Task..." -ForegroundColor Yellow

# Create the task
# /F force delete/create
# /SC ONLOGON run when user logs on
# /TR command to run
# /TN task name
# /NP no password
# /RL HIGHEST (not strictly needed but good for some environments)

$CreateCmd = "schtasks /Create /F /TN `"$TASK_NAME`" /TR `"$CMD`" /SC ONLOGON"
Invoke-Expression $CreateCmd | Out-Null

Write-Host "✓ Task created: $TASK_NAME" -ForegroundColor Green

# ============================================================================
# Load Service
# ============================================================================

Write-Host ""
Write-Host "→ Starting service..." -ForegroundColor Yellow

# Stop if running
schtasks /End /TN "$TASK_NAME" 2>$null | Out-Null

# Start service
schtasks /Run /TN "$TASK_NAME" | Out-Null

Write-Host "✓ Service started successfully" -ForegroundColor Green

# ============================================================================
# Summary
# ============================================================================

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║                    Installation Complete!                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "✓ Task Name:      $TASK_NAME" -ForegroundColor Green
Write-Host "✓ Command:        $CMD" -ForegroundColor Green
Write-Host "✓ Backend Dir:    $BACKEND_DIR" -ForegroundColor Green
Write-Host ""
Write-Host "Useful Commands (PowerShell):" -ForegroundColor Blue
Write-Host "  View Status:    schtasks /Query /TN `"$TASK_NAME`" /V" -ForegroundColor Yellow
Write-Host "  Stop Service:   schtasks /End /TN `"$TASK_NAME`"" -ForegroundColor Yellow
Write-Host "  Start Service:  schtasks /Run /TN `"$TASK_NAME`"" -ForegroundColor Yellow
Write-Host "  Delete Task:    schtasks /Delete /F /TN `"$TASK_NAME`"" -ForegroundColor Yellow
Write-Host ""
Write-Host "→ IMPORTANT: Ensure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set" -ForegroundColor Yellow
Write-Host "   in your environment or .env file." -ForegroundColor Yellow
Write-Host ""
