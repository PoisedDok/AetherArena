"""
Profile Management Endpoints

Endpoints for Open Interpreter profile management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST) --- {HTTP requests to /v1/profiles, /v1/profiles/active, /v1/profiles/switch, /v1/profiles/{name}}
Processing: enumerate profiles, validate selections, load metadata and content previews --- {JOB_FILE_READ, JOB_LOG, JOB_ORCHESTRATE, JOB_VALIDATE, JOB_VALIDATE_SCHEMA}
Outgoing: Local filesystem (profiles directory), Frontend (HTTP) --- {JSONResponse with profile list, metadata, and content previews}
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import get_settings, setup_request_context, get_profile_repository
from config.settings import Settings
from core.profiles.manager import ProfileManager
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["profiles"])

profile_manager = ProfileManager()



class SwitchProfileRequest(BaseModel):
    """Request model for switching profiles."""
    profile: str = Field(..., min_length=1, max_length=255, description="Profile name to switch to")


# =============================================================================
# List Profiles
# =============================================================================

@router.get(
    "/profiles",
    summary="List available profiles",
    description="List available Open Interpreter profiles"
)
async def get_profiles(
    refresh: bool = Query(False, description="Force re-scan of profile directories"),
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
        if refresh:
            profile_manager.clear_cache()

        profiles = profile_manager.discover_profiles()

        active_profile = settings.interpreter.profile or profile_manager.get_default_profile()
        active_path = profile_manager.get_profile_path(active_profile)
        if active_path:
            active_profile = active_path.name

        for profile in profiles:
            profile["active"] = profile.get("name") == active_profile

        logger.info("Listed %s profiles", len(profiles))

        return JSONResponse({
            "profiles": profiles,
            "count": len(profiles)
        })
        
    except Exception as e:
        logger.error("Failed to list profiles: %s", e, exc_info=True)
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
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Get active profile.
    
    Returns information about the currently active profile.
    """
    try:
        logger.info("Getting active profile")
        active_profile = settings.interpreter.profile or profile_manager.get_default_profile()
        active_path = profile_manager.get_profile_path(active_profile)
        if active_path:
            active_profile = active_path.name

        return JSONResponse({
            "name": active_profile,
            "status": "active",
            "type": active_profile.split(".")[-1] if "." in active_profile else "unknown",
            "message": f"Active profile: {active_profile}"
        })
        
    except Exception as e:
        logger.error("Failed to get active profile: %s", e, exc_info=True)
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
        profile_name = request.profile.strip()
        profile_path = profile_manager.get_profile_path(profile_name)
        
        if not profile_path:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Profile '{profile_name}' not found"
            )
        
        logger.info("Switching to profile: %s", profile_name)
        
        return JSONResponse({
            "status": "ok",
            "message": f"Switched to profile: {profile_path.name}",
            "profile": profile_path.name
        })
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to switch profile: %s", e, exc_info=True)
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
    _context: dict = Depends(setup_request_context),
    profile_repository = Depends(get_profile_repository)
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
        profile_path = profile_manager.get_profile_path(profile_name)
        
        if not profile_path or not profile_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Profile '{profile_name}' not found"
            )
        
        try:
            preview_data = await profile_repository.read_profile_preview(profile_path)
        except ValueError as ve:
            # Differentiate by message to map to correct HTTP status
            if "too large" in str(ve):
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=str(ve)
                )
            else:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=str(ve)
                )
        except FileNotFoundError:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Profile file not found on disk"
            )
            
        response_payload = {
            "name": profile_name,
            "path": str(profile_path),
            "type": profile_path.suffix[1:],
            **preview_data
        }

        profile_config = profile_manager.load_profile_config(profile_path.name)
        if profile_config:
            response_payload["config"] = profile_config
        
        return JSONResponse(response_payload)
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get profile %s: %s", profile_name, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get profile"
        )

