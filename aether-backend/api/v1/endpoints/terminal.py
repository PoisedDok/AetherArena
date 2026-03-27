"""
Terminal Operations Endpoints

Endpoints for terminal/shell operations.

@.architecture
Incoming: api/v1/router.py, frontend HTTP clients --- {HTTPRequest, Dict[str, Any]}
Processing: detect platform support, launch terminal subprocess --- {JOB_EXECUTE_TOOL}
Outgoing: local OS terminal application, frontend HTTP clients --- {JSONResponse, Dict[str, Any]}
"""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from core.exceptions import DomainException
from api.dependencies import (
    setup_request_context,
    get_settings,
    require_local_request,
    get_terminal_service,
)
from application.terminal.terminal_service import TerminalService, TerminalServiceDisabledError
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(
    tags=["terminal"],
)


# =============================================================================
# Launch Terminal
# =============================================================================

@router.get(
    "/launch_terminal",
    summary="Launch terminal",
    description="Launch system terminal application"
)
async def launch_terminal(
    request: Request,
    settings = Depends(get_settings),
    terminal_service: TerminalService = Depends(get_terminal_service),
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
        require_local_request(request, settings)
        
        try:
            terminal_info = terminal_service.launch_terminal()
        except TerminalServiceDisabledError as e:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(e)
            )
        
        if not terminal_info.success:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=f"Terminal launch not supported or failed on {terminal_info.platform}"
            )
        
        logger.info("Launched terminal: %s on %s", terminal_info.terminal, terminal_info.platform)
        
        return JSONResponse({
            "success": terminal_info.success,
            "terminal": terminal_info.terminal,
            "platform": terminal_info.platform
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to launch terminal: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to launch terminal"
        )

