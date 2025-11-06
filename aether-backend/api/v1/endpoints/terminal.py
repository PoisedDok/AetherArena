"""
Terminal Operations Endpoints

Endpoints for terminal/shell operations.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET) --- {HTTP requests to /v1/launch_terminal}
Processing: launch_terminal() --- {1 job: terminal_launch}
Outgoing: OS subprocess (terminal app), Frontend (HTTP) --- {subprocess.Popen to launch terminal, JSONResponse with terminal type and status}
"""

import platform
import subprocess
from typing import Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from api.dependencies import setup_request_context
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["terminal"])


# =============================================================================
# Launch Terminal
# =============================================================================

@router.get(
    "/launch_terminal",
    summary="Launch terminal",
    description="Launch system terminal application"
)
async def launch_terminal(
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Launch system terminal.
    
    Opens the default terminal application for the current platform:
    - macOS: Terminal.app or iTerm2
    - Windows: cmd.exe or PowerShell
    - Linux: gnome-terminal, konsole, xterm, etc.
    
    Returns:
        Success status and terminal type
    """
    try:
        system = platform.system()
        terminal_type = "unknown"
        
        if system == "Darwin":  # macOS
            # Try iTerm2 first, fallback to Terminal.app
            try:
                subprocess.Popen(["open", "-a", "iTerm"])
                terminal_type = "iTerm2"
            except:
                subprocess.Popen(["open", "-a", "Terminal"])
                terminal_type = "Terminal.app"
                
        elif system == "Windows":
            # Launch Windows Terminal or fallback to cmd
            try:
                subprocess.Popen(["wt.exe"])
                terminal_type = "Windows Terminal"
            except:
                subprocess.Popen(["cmd.exe", "/K", "start"])
                terminal_type = "cmd.exe"
                
        elif system == "Linux":
            # Try various Linux terminal emulators
            terminals = [
                ("gnome-terminal", "GNOME Terminal"),
                ("konsole", "Konsole"),
                ("xfce4-terminal", "XFCE Terminal"),
                ("xterm", "XTerm")
            ]
            
            launched = False
            for terminal_cmd, terminal_name in terminals:
                try:
                    subprocess.Popen([terminal_cmd])
                    terminal_type = terminal_name
                    launched = True
                    break
                except FileNotFoundError:
                    continue
            
            if not launched:
                raise HTTPException(
                    status_code=status.HTTP_501_NOT_IMPLEMENTED,
                    detail="No supported terminal emulator found"
                )
        else:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=f"Terminal launch not supported on {system}"
            )
        
        logger.info(f"Launched terminal: {terminal_type} on {system}")
        
        return JSONResponse({
            "success": True,
            "terminal": terminal_type,
            "platform": system
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to launch terminal: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to launch terminal: {str(e)}"
        )

