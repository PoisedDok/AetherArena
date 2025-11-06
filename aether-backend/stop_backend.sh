#!/bin/bash

# Stop Aether Backend and clear port

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Stopping Aether Backend...${NC}"

# Find and kill backend process
if lsof -ti:5002 > /dev/null 2>&1; then
    echo -e "${YELLOW}Found process on port 5002${NC}"
    
    # Try graceful shutdown first
    lsof -ti:5002 | xargs kill -TERM 2>/dev/null
    
    # Wait for graceful shutdown
    sleep 3
    
    # Force kill if still running
    if lsof -ti:5002 > /dev/null 2>&1; then
        echo -e "${YELLOW}Forcing shutdown...${NC}"
        lsof -ti:5002 | xargs kill -9 2>/dev/null
    fi
    
    sleep 1
    echo -e "${GREEN}✅ Backend stopped${NC}"
    echo -e "${GREEN}✅ Port 5002 cleared${NC}"
else
    echo -e "${GREEN}✅ No backend running on port 5002${NC}"
fi

# Verify port is clear
if lsof -ti:5002 > /dev/null 2>&1; then
    echo -e "${RED}❌ Failed to clear port 5002${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Port verified clear${NC}"
fi

