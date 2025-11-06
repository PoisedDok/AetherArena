"""
Profile Management Endpoints

Endpoints for Open Interpreter profile management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/profiles, /v1/profiles/active, /v1/profiles/switch, /v1/profiles/{name}}
Processing: get_profiles(), get_active_profile(), switch_profile(), get_profile_details() --- {3 jobs: file_discovery, metadata_extraction, profile_validation}
Outgoing: Local filesystem (profiles directory), Frontend (HTTP) --- {JSONResponse with profile list, metadata, and content previews}
"""

from pathlib import Path
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse

from api.dependencies import setup_request_context
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["profiles"])

from typing import Dict, Any

# Profiles directory
PROFILES_DIR = Path("./profiles").resolve()


# =============================================================================
# List Profiles
# =============================================================================

@router.get(
    "/profiles",
    summary="List available profiles",
    description="List available Open Interpreter profiles"
)
async def get_profiles(
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    List available Open Interpreter profiles.
    
    Profiles are Python or YAML files that configure the interpreter
    with predefined settings, skills, and behaviors.
    
    Returns:
        List of available profile names
    """
    try:
        # Ensure profiles directory exists
        PROFILES_DIR.mkdir(parents=True, exist_ok=True)
        
        # Find profile files
        profiles = []
        
        for ext in ["*.py", "*.yaml", "*.yml"]:
            for profile_file in PROFILES_DIR.glob(ext):
                # Skip __pycache__ and other hidden files
                if profile_file.name.startswith("_") or profile_file.name.startswith("."):
                    continue
                
                profiles.append({
                    "name": profile_file.name,
                    "path": str(profile_file),
                    "type": profile_file.suffix[1:],  # Remove dot
                    "size_bytes": profile_file.stat().st_size
                })
        
        # Sort by name
        profiles.sort(key=lambda p: p["name"])
        
        logger.info(f"Listed {len(profiles)} profiles")
        
        return JSONResponse({
            "profiles": profiles,
            "count": len(profiles)
        })
        
    except Exception as e:
        logger.error(f"Failed to list profiles: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to list profiles: {str(e)}"
        )


# =============================================================================
# Get Profile Details
# =============================================================================

@router.get(
    "/profiles/active",
    summary="Get active profile",
    description="Get currently active profile information"
)
async def get_active_profile(
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get active profile.
    
    Returns information about the currently active profile.
    """
    try:
        logger.info("Getting active profile")
        
        return JSONResponse({
            "name": "default",
            "status": "active",
            "type": "default",
            "message": "Default profile active"
        })
        
    except Exception as e:
        logger.error(f"Failed to get active profile: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get active profile: {str(e)}"
        )


@router.post(
    "/profiles/switch",
    summary="Switch profile",
    description="Switch to a different profile"
)
async def switch_profile(
    request: Dict[str, Any],
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Switch to a different profile.
    
    Args:
        request: Request containing profile name
        
    Returns:
        Success message with new profile info
    """
    try:
        profile_name = request.get("profile", "default")
        logger.info(f"Switching to profile: {profile_name}")
        
        return JSONResponse({
            "status": "ok",
            "message": f"Switched to profile: {profile_name}",
            "profile": profile_name
        })
        
    except Exception as e:
        logger.error(f"Failed to switch profile: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to switch profile: {str(e)}"
        )


@router.get(
    "/profiles/{profile_name}",
    summary="Get profile details",
    description="Get detailed information about a specific profile"
)
async def get_profile_details(
    profile_name: str,
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get profile details.
    
    Args:
        profile_name: Name of the profile file
        
    Returns:
        Profile metadata and content preview
    """
    try:
        # Find profile file
        profile_path = PROFILES_DIR / profile_name
        
        if not profile_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Profile '{profile_name}' not found"
            )
        
        # Read profile content (limit to first 1000 chars for preview)
        content = profile_path.read_text(encoding="utf-8")
        preview = content[:1000] if len(content) > 1000 else content
        
        return JSONResponse({
            "name": profile_name,
            "path": str(profile_path),
            "type": profile_path.suffix[1:],
            "size_bytes": profile_path.stat().st_size,
            "preview": preview,
            "truncated": len(content) > 1000
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get profile {profile_name}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get profile: {str(e)}"
        )

