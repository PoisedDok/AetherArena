#!/bin/bash
# ============================================================================
# Aether File Indexing Service - LaunchAgent Installation Script (macOS)
# ============================================================================
# This script installs the file indexing service as a macOS LaunchAgent
# that runs automatically on user login and survives system restarts.

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Service configuration
SERVICE_NAME="com.aether.fileindexing"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PLIST_SOURCE="$SCRIPT_DIR/$SERVICE_NAME.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
DATA_ROOT="$HOME/Library/Application Support/Aether"
LOG_DIR="$DATA_ROOT/logs"
STDOUT_LOG="$LOG_DIR/file_indexing.stdout.log"
ERROR_LOG="$LOG_DIR/file_indexing.stderr.log"

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║      Aether File Indexing Service - LaunchAgent Setup       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# Pre-flight Checks
# ============================================================================

echo -e "${YELLOW}→${NC} Running pre-flight checks..."

# Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo -e "${RED}✗${NC} This script is for macOS only. For Linux, use systemd."
    exit 1
fi

# Check if plist source exists
if [[ ! -f "$PLIST_SOURCE" ]]; then
    echo -e "${RED}✗${NC} Plist file not found: $PLIST_SOURCE"
    exit 1
fi

# Check for Python or Packaged Binary
BACKEND_BIN="$BACKEND_DIR/aether-hub"
MAIN_PY="$BACKEND_DIR/main.py"
PYTHON_PATH=$(which python3)

if [[ -f "$BACKEND_BIN" ]]; then
    EXE_PATH="$BACKEND_BIN"
    DAEMON_ARGS="aether_rag-daemon"
    echo -e "${GREEN}✓${NC} Found packaged binary: $BACKEND_BIN"
    PROGRAM_ARG_XML="        <string>$EXE_PATH</string>\n        <string>aether_rag-daemon</string>"
elif [[ -f "$MAIN_PY" ]]; then
    if [[ -z "$PYTHON_PATH" ]]; then
        echo -e "${RED}✗${NC} Python 3 not found. Please install Python 3."
        exit 1
    fi
    EXE_PATH="$PYTHON_PATH"
    echo -e "${GREEN}✓${NC} Found source: $MAIN_PY (using $PYTHON_PATH)"
    PROGRAM_ARG_XML="        <string>$EXE_PATH</string>\n        <string>-m</string>\n        <string>services.daemons.file_indexing.daemon</string>"
else
    echo -e "${RED}✗${NC} Neither aether-hub nor main.py found in $BACKEND_DIR"
    exit 1
fi

# ============================================================================
# Environment Configuration
# ============================================================================

echo ""
echo -e "${YELLOW}→${NC} Configuring environment variables..."

# Check for .env or local.env file
ENV_FILE="$BACKEND_DIR/.env"
LOCAL_ENV="$BACKEND_DIR/config/local.env"

if [[ -f "$LOCAL_ENV" ]]; then
    ENV_FILE="$LOCAL_ENV"
fi

if [[ -f "$ENV_FILE" ]]; then
    echo -e "${GREEN}✓${NC} Found env file: $ENV_FILE"
    
    # Extract values for plist (fallback to placeholders if not found)
    SUPABASE_URL=$(grep "^SUPABASE_URL=" "$ENV_FILE" | cut -d'=' -f2-)
    SUPABASE_KEY=$(grep "^SUPABASE_SERVICE_ROLE_KEY=" "$ENV_FILE" | cut -d'=' -f2-)
    
    [[ -z "$SUPABASE_URL" ]] && echo -e "${YELLOW}⚠${NC}  SUPABASE_URL not set in $ENV_FILE"
    [[ -z "$SUPABASE_KEY" ]] && echo -e "${YELLOW}⚠${NC}  SUPABASE_SERVICE_ROLE_KEY not set in $ENV_FILE"
else
    echo -e "${YELLOW}⚠${NC}  No env file found. Using default placeholders."
fi

# ============================================================================
# Install LaunchAgent
# ============================================================================

echo ""
echo -e "${YELLOW}→${NC} Installing LaunchAgent..."

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

# Copy plist and update paths
cp "$PLIST_SOURCE" "$PLIST_DEST"

# Replace placeholders with actual values
if [[ "$(uname)" == "Darwin" ]]; then
    # macOS sed syntax
    # Use a character that doesn't appear in the XML/Paths as delimiter (e.g., |)
    sed -i '' "s|{{PROGRAM_ARGUMENTS}}|$PROGRAM_ARG_XML|g" "$PLIST_DEST"
    sed -i '' "s|{{BACKEND_DIR}}|$BACKEND_DIR|g" "$PLIST_DEST"
    sed -i '' "s|{{AETHER_BACKEND_ROOT}}|$DATA_ROOT|g" "$PLIST_DEST"
    sed -i '' "s|{{SUPABASE_URL}}|${SUPABASE_URL:-YOUR_SUPABASE_URL}|g" "$PLIST_DEST"
    sed -i '' "s|{{SUPABASE_SERVICE_ROLE_KEY}}|${SUPABASE_KEY:-YOUR_SUPABASE_SERVICE_ROLE_KEY}|g" "$PLIST_DEST"
    sed -i '' "s|{{STDOUT_LOG_PATH}}|$STDOUT_LOG|g" "$PLIST_DEST"
    sed -i '' "s|{{STDERR_LOG_PATH}}|$ERROR_LOG|g" "$PLIST_DEST"
fi

echo -e "${GREEN}✓${NC} LaunchAgent installed to: $PLIST_DEST"

# ============================================================================
# Load Service
# ============================================================================

echo ""
echo -e "${YELLOW}→${NC} Loading service..."

# Unload if already loaded
if launchctl list | grep -q "$SERVICE_NAME"; then
    echo -e "${BLUE}ℹ${NC}  Service already loaded. Reloading..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Load service
launchctl load "$PLIST_DEST"

# Give it a moment to start
sleep 2

# Check if service is running
if launchctl list | grep -q "$SERVICE_NAME"; then
    echo -e "${GREEN}✓${NC} Service loaded successfully"
else
    echo -e "${RED}✗${NC} Service failed to load"
    exit 1
fi

# ============================================================================
# Verification
# ============================================================================

echo ""
echo -e "${YELLOW}→${NC} Verifying service..."

# Check logs
if [[ -f "$STDOUT_LOG" ]]; then
    echo -e "${GREEN}✓${NC} Service log created: $STDOUT_LOG"
    echo -e "${BLUE}ℹ${NC}  Recent log entries:"
    tail -n 5 "$STDOUT_LOG" | sed 's/^/    /'
else
    echo -e "${YELLOW}⚠${NC}  No log file yet. Service may still be starting."
fi

if [[ -f "$ERROR_LOG" && -s "$ERROR_LOG" ]]; then
    echo -e "${YELLOW}⚠${NC}  Errors detected: $ERROR_LOG"
    echo -e "${BLUE}ℹ${NC}  Recent errors:"
    tail -n 5 "$ERROR_LOG" | sed 's/^/    /'
fi

# ============================================================================
# Summary
# ============================================================================

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    Installation Complete!                   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}✓${NC} Service Name:    $SERVICE_NAME"
echo -e "${GREEN}✓${NC} Configuration:   $PLIST_DEST"
echo -e "${GREEN}✓${NC} Log File:        $STDOUT_LOG"
echo -e "${GREEN}✓${NC} Error Log:       $ERROR_LOG"
echo ""
echo -e "${BLUE}Useful Commands:${NC}"
echo -e "  ${YELLOW}View Status:${NC}    launchctl list | grep $SERVICE_NAME"
echo -e "  ${YELLOW}Stop Service:${NC}   launchctl unload $PLIST_DEST"
echo -e "  ${YELLOW}Start Service:${NC}  launchctl load $PLIST_DEST"
echo -e "  ${YELLOW}View Logs:${NC}      tail -f $STDOUT_LOG"
echo -e "  ${YELLOW}View Errors:${NC}    tail -f $ERROR_LOG"
echo -e "  ${YELLOW}Uninstall:${NC}      ./uninstall.sh"
echo ""
echo -e "${YELLOW}⚠${NC}  ${YELLOW}IMPORTANT:${NC} Make sure to configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
echo -e "   in the plist file if they weren't auto-configured."
echo ""

