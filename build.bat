@echo off
REM AetherArena Desktop Application - Build Script (Windows)
REM Builds backend binary with PyInstaller and packages with electron-builder

setlocal EnableDelayedExpansion

echo ============================================================
echo AetherArena Desktop Application - Build Script
echo ============================================================

REM Get script directory
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"

REM Step 0: Prepare directories
echo.
echo [0/4] Preparing directories...
if not exist aether-frontend\resources\bin\darwin mkdir aether-frontend\resources\bin\darwin
if not exist aether-frontend\resources\bin\win32 mkdir aether-frontend\resources\bin\win32
echo [OK] Directories created

REM Step 1: Build backend binary
echo.
echo [1/4] Building backend binary with PyInstaller...
cd aether-backend

REM Check if virtual environment exists
if exist venv\Scripts\activate.bat (
    echo Activating virtual environment...
    call venv\Scripts\activate.bat
) else (
    echo [WARNING] No virtual environment found at aether-backend\venv
    echo           Using system Python
)

REM Clean previous builds
echo Cleaning previous builds...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

REM Run PyInstaller
echo Running PyInstaller...
pyinstaller build-config.spec
if errorlevel 1 (
    echo [ERROR] PyInstaller build failed
    exit /b 1
)
echo [OK] Backend binary built successfully

REM Copy binary to resources
echo Copying binary to resources...
if exist dist\aether-hub.exe (
    copy /y dist\aether-hub.exe ..\aether-frontend\resources\bin\win32\
    echo [OK] Binary copied to aether-frontend\resources\bin\win32\
) else (
    echo [ERROR] Binary not found at dist\aether-hub.exe
    exit /b 1
)

cd /d "%SCRIPT_DIR%"

REM Step 2: Build frontend
echo.
echo [2/4] Building frontend...
cd aether-frontend

REM Check if node_modules exists
if not exist node_modules (
    echo Installing npm dependencies...
    call npm install
)

REM Build renderers and preload
echo Building renderers and preload scripts...
call npm run build:all
if errorlevel 1 (
    echo [ERROR] Frontend build failed
    exit /b 1
)
echo [OK] Frontend built successfully

REM Step 3: Package application
echo.
echo [3/4] Packaging application with electron-builder...
echo Building for Windows...
call npm run build:win
if errorlevel 1 (
    echo [ERROR] electron-builder failed
    exit /b 1
)
echo [OK] Windows application packaged

cd /d "%SCRIPT_DIR%"

REM Step 4: Summary
echo.
echo [4/4] Build Summary
echo ============================================================

if exist aether-frontend\dist (
    echo [OK] Build complete!
    echo.
    echo Output files:
    dir /b aether-frontend\dist\*.exe
    echo.
    echo Backend binary size:
    dir aether-frontend\resources\bin\win32\aether-hub.exe
) else (
    echo [ERROR] Build failed - no dist directory found
    exit /b 1
)

echo ============================================================
echo AetherArena Desktop Application build complete!
echo ============================================================

endlocal
