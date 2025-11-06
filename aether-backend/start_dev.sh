#!/bin/bash

# Aether Backend - Development Mode Startup
# Runs in isolated environment with full logging and easy shutdown

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}============================================================${NC}"
echo -e "${BLUE}Aether Backend - Development Mode${NC}"
echo -e "${BLUE}============================================================${NC}"

# Navigate to backend directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo -e "\n${YELLOW}[1/5] Checking environment...${NC}"

# Check Python version
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python 3 not found${NC}"
    exit 1
fi

PYTHON_VERSION=$(python3 --version)
echo -e "${GREEN}✅ $PYTHON_VERSION${NC}"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}⚠️  Virtual environment not found, creating...${NC}"
    python3 -m venv venv
    echo -e "${GREEN}✅ Virtual environment created${NC}"
fi

# Activate virtual environment
echo -e "\n${YELLOW}[2/5] Activating virtual environment...${NC}"
source venv/bin/activate
echo -e "${GREEN}✅ Virtual environment activated${NC}"

# Check/install dependencies
echo -e "\n${YELLOW}[3/5] Checking dependencies...${NC}"
if [ -f "requirements.txt" ]; then
    pip install -q -r requirements.txt
    echo -e "${GREEN}✅ Dependencies installed${NC}"
else
    echo -e "${YELLOW}⚠️  requirements.txt not found${NC}"
fi

# Clear port if in use
echo -e "\n${YELLOW}[4/5] Checking port 8765...${NC}"
if lsof -ti:8765 > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Port 8765 in use, clearing...${NC}"
    lsof -ti:8765 | xargs kill -9 2>/dev/null || true
    sleep 2
    echo -e "${GREEN}✅ Port 8765 cleared${NC}"
else
    echo -e "${GREEN}✅ Port 8765 available${NC}"
fi

# Set environment variables for development
export AETHER_ENVIRONMENT="development"
export MONITORING_LOG_LEVEL="DEBUG"
export PYTHONUNBUFFERED=1

echo -e "\n${YELLOW}[5/5] Starting backend in development mode...${NC}"
echo -e "${BLUE}============================================================${NC}"
echo -e "${GREEN}Backend URL: http://127.0.0.1:8765${NC}"
echo -e "${GREEN}Docs: http://127.0.0.1:8765/docs${NC}"
echo -e "${GREEN}Health: http://127.0.0.1:8765/v1/health${NC}"
echo -e "${BLUE}============================================================${NC}"
echo -e "${YELLOW}Press Ctrl+C to stop the backend gracefully${NC}"
echo -e "${BLUE}============================================================${NC}\n"

# Trap for graceful shutdown
trap 'echo -e "\n${YELLOW}🛑 Shutting down gracefully...${NC}"; kill $BACKEND_PID 2>/dev/null; wait $BACKEND_PID 2>/dev/null; echo -e "${GREEN}✅ Backend stopped${NC}"; exit 0' INT TERM

# Start backend with uvicorn in development mode
python3 -m uvicorn main:app \
    --host 127.0.0.1 \
    --port 8765 \
    --reload \
    --log-level debug \
    --access-log \
    --use-colors &

BACKEND_PID=$!

# Wait for backend to start
sleep 3

# Check if backend is running
if kill -0 $BACKEND_PID 2>/dev/null; then
    echo -e "${GREEN}✅ Backend started successfully (PID: $BACKEND_PID)${NC}"
    echo -e "${GREEN}✅ Logs are streaming below...${NC}\n"
    
    # Wait for the backend process
    wait $BACKEND_PID
else
    echo -e "${RED}❌ Backend failed to start${NC}"
    exit 1
fi

