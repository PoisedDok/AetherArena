@echo off
setlocal enabledelayedexpansion

:: @.architecture
:: Incoming: packaged app launcher (Electron), production environment --- {CLI args, Path}
:: Processing: load_env(), ensure_supabase_health(), launch_packaged_services() --- {3 jobs: JOB_APPLY_CONFIG, JOB_HEALTH_CHECK, JOB_SPAWN_PROCESS}
:: Outgoing: aether-hub binary processes, production logs --- {process_id, text}

:: Aether Backend - Packaged Production Startup Script (Windows)
:: Designed for use within packaged AetherArena distributions.
:: Orchestrates binary lifecycle, health checks, and logging.

set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

:: Production paths
set LOG_DIR=%SCRIPT_DIR%logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

:: Single binary entry point
set BACKEND_BIN=%SCRIPT_DIR%aether-hub.exe
if not exist "%BACKEND_BIN%" (
    :: Fallback for dev testing
    if exist "%SCRIPT_DIR%main.py" (
        set BACKEND_BIN=python "%SCRIPT_DIR%main.py"
    ) else (
        echo ❌ Backend binary not found: %BACKEND_BIN%
        exit /b 1
    )
)

:: 1. Load configuration (simplified .env loading)
set BACKEND_ENV_FILE=%SCRIPT_DIR%config\local.env
if exist "%BACKEND_ENV_FILE%" (
    for /f "tokens=*" %%i in ('type "%BACKEND_ENV_FILE%" ^| findstr /v "^#"') do (
        set "%%i"
    )
)

:: Set production defaults
set AETHER_ENVIRONMENT=production
set MONITORING_LOG_LEVEL=INFO
set PYTHONUNBUFFERED=1

:: 2. Cleanup old instances
echo 🧹 Cleaning up previous instances...
:: Kill processes on port 8765
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8765 ^| findstr LISTENING') do (
    taskkill /F /PID %%a 2>nul
)

:: 3. Ensure External Dependencies
echo [1/4] Verifying external dependencies...

:: Check Supabase
curl -s -f -o NUL "http://localhost:54321/rest/v1/" -H "apikey: %SUPABASE_ANON_KEY%"
if %ERRORLEVEL% equ 0 (
    echo ✅ Supabase API is healthy
) else (
    echo ❌ Supabase API unreachable at http://localhost:54321
    echo Please ensure Docker Desktop is running and Supabase is started.
    exit /b 1
)

:: 4. Start Packaged Services
echo [2/4] Launching background watchdogs...

:: Start Embedding Service Watchdog (hidden window using start /B)
start /B "Aether Embedding Watchdog" %BACKEND_BIN% embedding-watchdog >> "%LOG_DIR%\embedding-watchdog.log" 2>&1

:: Start Job Worker Watchdog
start /B "Aether Worker Watchdog" %BACKEND_BIN% worker-watchdog >> "%LOG_DIR%\worker-watchdog.log" 2>&1

:: Start Aether-RAG Daemon (if configured to start with app)
start /B "Aether Aether-RAG Daemon" %BACKEND_BIN% aether-rag-daemon >> "%LOG_DIR%\aether-rag-daemon.log" 2>&1

:: 5. Start Main API Server
echo [3/4] Starting Aether API Server...
echo ============================================================
echo Environment: %AETHER_ENVIRONMENT%
echo Log Level:   %MONITORING_LOG_LEVEL%
echo ============================================================

:: Launch main API in foreground to keep script alive
%BACKEND_BIN% api
