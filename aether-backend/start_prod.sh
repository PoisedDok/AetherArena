#!/bin/bash

# Aether Backend - Production Mode Startup
# Production-ready with optimized settings

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}Aether Backend - Production Mode${NC}"
echo -e "${BLUE}============================================================${NC}"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "\n${YELLOW}[1/4] Environment check...${NC}"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python 3 not found${NC}"
    exit 1
fi
echo -e "${GREEN}✅ $(python3 --version)${NC}"

# Virtual environment
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}Creating virtual environment...${NC}"
    python3 -m venv venv
fi

source venv/bin/activate
echo -e "${GREEN}✅ Virtual environment activated${NC}"

echo -e "\n${YELLOW}[2/4] Dependencies...${NC}"
if [ -f "requirements.txt" ]; then
    pip install -q -r requirements.txt
    echo -e "${GREEN}✅ Dependencies ready${NC}"
fi

echo -e "\n${YELLOW}[3/4] Port check...${NC}"
if lsof -ti:5002 > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Clearing port 5002...${NC}"
    lsof -ti:5002 | xargs kill -9 2>/dev/null || true
    sleep 2
fi
echo -e "${GREEN}✅ Port 5002 available${NC}"

# Production environment
export AETHER_ENVIRONMENT="production"
export MONITORING_LOG_LEVEL="INFO"
export PYTHONUNBUFFERED=1

echo -e "\n${YELLOW}[4/4] Starting production backend...${NC}"
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}Backend: http://127.0.0.1:5002${NC}"
echo -e "${GREEN}Mode: PRODUCTION${NC}"
echo -e "${BLUE}============================================================${NC}"
echo -e "${YELLOW}Press Ctrl+C for graceful shutdown${NC}"
echo -e "${BLUE}============================================================${NC}\n"

# Graceful shutdown trap
trap 'echo -e "\n${YELLOW}🛑 Graceful shutdown initiated...${NC}"; kill -TERM $BACKEND_PID 2>/dev/null; wait $BACKEND_PID 2>/dev/null; echo -e "${GREEN}✅ Backend stopped cleanly${NC}"; lsof -ti:5002 | xargs kill -9 2>/dev/null || true; echo -e "${GREEN}✅ Port 5002 cleared${NC}"; exit 0' INT TERM

# Start backend (production settings)
python3 -m uvicorn main:app \
    --host 127.0.0.1 \
    --port 5002 \
    --workers 1 \
    --log-level info \
    --no-access-log &

BACKEND_PID=$!

sleep 3

if kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${GREEN}✅ Production backend running (PID: $BACKEND_PID)${NC}\n"
    wait $BACKEND_PID
else
    echo -e "${RED}❌ Backend failed to start${NC}"
    exit 1
fi

