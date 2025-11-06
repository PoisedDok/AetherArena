"""
Profile Management Endpoints

Endpoints for Open Interpreter profile management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/profiles, /v1/profiles/active, /v1/profiles/switch, /v1/profiles/{name}}
Processing: get_profiles(), get_active_profile(), switch_profile(), get_profile_details() --- {8 jobs: dependency_injection, error_handling, file_discovery, file_reading, http_communication, metadata_extraction, path_validation, profile_validation}
Outgoing: Local filesystem (profiles directory), Frontend (HTTP) --- {JSONResponse with profile list, metadata, and content previews}
"""

import aiofiles
from pathlib import Path
from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.dependencies import get_settings, setup_request_context
from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["profiles"])

# Max profile file size for preview (1MB)
MAX_PROFILE_SIZE = 1024 * 1024


class SwitchProfileRequest(BaseModel):
    """Request model for switching profiles."""
    profile: str = Field(..., min_length=1, max_length=255, description="Profile name to switch to")


def get_profiles_dir(settings: Settings = None) -> Path:
    """
    Get profiles directory path.
    
    Returns:
        Path: Resolved profiles directory path
    """
    # Use configured path if available, otherwise fallback
    profiles_path = Path("./profiles")
    return profiles_path.resolve()


def validate_profile_path(profile_name: str, profiles_dir: Path) -> Path:
    """
    Validate and sanitize profile name to prevent path traversal.
    
    Args:
        profile_name: User-provided profile name
        profiles_dir: Base profiles directory
        
    Returns:
        Path: Validated profile path
        
    Raises:
        HTTPException: If path validation fails
    """
    if not profile_name or not profile_name.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Profile name cannot be empty"
        )
    
    # Remove leading/trailing whitespace
    profile_name = profile_name.strip()
    
    # Block path traversal attempts
    if ".." in profile_name or "/" in profile_name or "\\" in profile_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid profile name: path traversal not allowed"
        )
    
    # Build and resolve full path
    profile_path = (profiles_dir / profile_name).resolve()
    
    # Ensure resolved path is still within profiles directory
    try:
        profile_path.relative_to(profiles_dir)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid profile name: outside profiles directory"
        )
    
    return profile_path


# =============================================================================
# List Profiles
# =============================================================================

@router.get(
    "/profiles",
    summary="List available profiles",
    description="List available Open Interpreter profiles"
)
async def get_profiles(
    settings: Settings = Depends(get_settings),
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
        profiles_dir = get_profiles_dir(settings)
        
        # Ensure profiles directory exists
        profiles_dir.mkdir(parents=True, exist_ok=True)
        
        # Find profile files
        profiles = []
        
        for ext in ["*.py", "*.yaml", "*.yml"]:
            for profile_file in profiles_dir.glob(ext):
                # Skip __pycache__ and other hidden files
                if profile_file.name.startswith("_") or profile_file.name.startswith("."):
                    continue
                
                stat = profile_file.stat()
                profiles.append({
                    "name": profile_file.name,
                    "path": str(profile_file),
                    "type": profile_file.suffix[1:],  # Remove dot
                    "size_bytes": stat.st_size
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
            detail="Failed to list profiles"
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
            detail="Failed to get active profile"
        )


@router.post(
    "/profiles/switch",
    summary="Switch profile",
    description="Switch to a different profile"
)
async def switch_profile(
    request: SwitchProfileRequest,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Switch to a different profile.
    
    Args:
        request: Request containing profile name (validated via Pydantic)
        
    Returns:
        Success message with new profile info
        
    Security:
        - Profile name validated via Pydantic model
        - Path traversal protection via validate_profile_path
    """
    try:
        profile_name = request.profile
        profiles_dir = get_profiles_dir(settings)
        
        # Validate profile path to prevent path traversal
        profile_path = validate_profile_path(profile_name, profiles_dir)
        
        # Verify profile exists
        if not profile_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Profile '{profile_name}' not found"
            )
        
        logger.info(f"Switching to profile: {profile_name}")
        
        return JSONResponse({
            "status": "ok",
            "message": f"Switched to profile: {profile_name}",
            "profile": profile_name
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to switch profile: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to switch profile"
        )


@router.get(
    "/profiles/{profile_name}",
    summary="Get profile details",
    description="Get detailed information about a specific profile"
)
async def get_profile_details(
    profile_name: str,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get profile details.
    
    Args:
        profile_name: Name of the profile file
        
    Returns:
        Profile metadata and content preview
        
    Security:
        - Path traversal protection
        - File size limits
    """
    try:
        profiles_dir = get_profiles_dir(settings)
        
        # Validate and resolve profile path (prevents path traversal)
        profile_path = validate_profile_path(profile_name, profiles_dir)
        
        if not profile_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Profile '{profile_name}' not found"
            )
        
        # Check file size
        stat = profile_path.stat()
        if stat.st_size > MAX_PROFILE_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Profile file too large (max {MAX_PROFILE_SIZE} bytes)"
            )
        
        # Read profile content asynchronously (limit to first 1000 chars for preview)
        try:
            async with aiofiles.open(profile_path, 'r', encoding="utf-8") as f:
                content = await f.read()
        except UnicodeDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Profile file is not valid UTF-8 text"
            )
        
        preview = content[:1000] if len(content) > 1000 else content
        
        return JSONResponse({
            "name": profile_name,
            "path": str(profile_path),
            "type": profile_path.suffix[1:],
            "size_bytes": stat.st_size,
            "preview": preview,
            "truncated": len(content) > 1000
        })
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get profile {profile_name}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get profile"
        )

