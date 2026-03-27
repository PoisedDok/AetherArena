#!/bin/bash
# ============================================================================
# Aether File Indexing Service - LaunchAgent Uninstallation Script (macOS)
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SERVICE_NAME="com.aether.fileindexing"
PLIST_DEST="$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
DATA_ROOT="$HOME/Library/Application Support/Aether"
LOG_DIR="$DATA_ROOT/logs"

echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    Aether File Indexing Service - LaunchAgent Uninstall     ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if service is loaded
if launchctl list | grep -q "$SERVICE_NAME"; then
    echo -e "${YELLOW}→${NC} Stopping service..."
    launchctl unload "$PLIST_DEST"
    echo -e "${GREEN}✓${NC} Service stopped"
else
    echo -e "${BLUE}ℹ${NC}  Service is not running"
fi

# Remove plist
if [[ -f "$PLIST_DEST" ]]; then
    echo -e "${YELLOW}→${NC} Removing LaunchAgent configuration..."
    rm "$PLIST_DEST"
    echo -e "${GREEN}✓${NC} Configuration removed: $PLIST_DEST"
else
    echo -e "${BLUE}ℹ${NC}  Configuration file not found"
fi

# Ask about log files
echo ""
echo -e "${YELLOW}?${NC} Remove log files? (y/N)"
read -r response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    rm -f "$LOG_DIR/file_indexing.stdout.log"
    rm -f "$LOG_DIR/file_indexing.stderr.log"
    rm -f "$LOG_DIR/file_indexing.log"
    # Legacy cleanup for historical launchers.
    rm -f /tmp/aether_file_indexing.log
    rm -f /tmp/aether_file_indexing.error.log
    echo -e "${GREEN}✓${NC} Log files removed"
fi

echo ""
echo -e "${GREEN}✓${NC} Uninstallation complete!"
echo ""

