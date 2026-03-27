"""
User Preferences Management Endpoints

@.architecture
Incoming: Frontend settings UI --- {GET/POST/DELETE requests}
Processing: get_preference(), set_preference(), get_all_preferences() --- {3 jobs: JOB_QUERY_DB, JOB_UPSERT_DATA, JOB_VALIDATE_INPUT}
Outgoing: Frontend --- {preference values, success responses}
"""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from typing import Any, Dict, Optional
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from application.settings.preferences_service import PreferencesService
from api.dependencies import get_database, get_settings, setup_request_context, get_preferences_service
from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/preferences", tags=["preferences"])

# Canonical defaults for preferences that the UI expects to exist.
# NOTE: These are backend-owned defaults; they should stay centralized and minimal.
_PREFERENCE_DEFAULTS: Dict[str, Any] = {
    # Handsfree mode is never enabled by default; user must explicitly opt in.
    "handsfree_enabled": {"enabled": False},
    # Onboarding completion status; defaults to False for new users.
    "onboarding_complete": False,
    # Aether Inference server: enabled by default (mirrors models.toml [INFERENCE].enabled).
    # User can toggle off to prevent auto-start on backend startup.
    # The inference server runs as a daemon that survives app restarts,
    # so this preference controls whether it should be auto-started.
    "inference_enabled": True,
    # Latest legal acceptance snapshot cache (source of truth is append-only events table).
    "legal_acceptance_latest": {
        "accepted": False,
        "terms_version": None,
        "terms_hash": None,
        "accepted_at": None,
    },
}


# ========================================
# Request/Response Schemas
# ========================================

class PreferenceValueRequest(BaseModel):
    """Request to set a preference value."""
    value: Any = Field(..., description="Preference value (any JSON-serializable type)")
    
    class Config:
        json_schema_extra = {
            "example": {
                "value": {"enabled": True}
            }
        }


class PreferenceResponse(BaseModel):
    """Preference response."""
    preference_key: str
    preference_value: Any
    user_id: str


class PreferencesListResponse(BaseModel):
    """All preferences response."""
    preferences: Dict[str, Any]
    user_id: str


class LegalAcceptanceRequest(BaseModel):
    """Payload for recording terms/license acceptance."""
    terms_version: str = Field(..., min_length=1, max_length=64)
    terms_hash: str = Field(..., min_length=8, max_length=128)
    acceptance_method: str = Field(default="checkbox", min_length=1, max_length=32)
    app_version: Optional[str] = Field(default=None, max_length=64)
    platform: Optional[str] = Field(default=None, max_length=64)
    source: str = Field(default="onboarding_modal", min_length=1, max_length=64)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class LegalAcceptanceResponse(BaseModel):
    """Response for legal acceptance write/read APIs."""
    accepted: bool
    user_id: str
    terms_version: str
    terms_hash: str
    accepted_at: str
    acceptance_method: str
    source: str


# ========================================
# Endpoints
# ========================================

@router.get("/", response_model=PreferencesListResponse)
async def get_all_preferences(
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service)
) -> PreferencesListResponse:
    """
    Get all user preferences.
    
    Returns:
        All preferences for the user
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        preferences = await preferences_service.get_all_preferences(user_id)
        
        return PreferencesListResponse(
            preferences=preferences,
            user_id=user_id
        )
        
    except Exception as e:
        logger.error("Failed to get preferences for user %s: %s", user_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve preferences. Check server logs for details."
        )


@router.get("/{preference_key}", response_model=PreferenceResponse)
async def get_preference(
    preference_key: str,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service)
) -> PreferenceResponse:
    """
    Get a specific user preference.
    
    Args:
        preference_key: Preference identifier (e.g., 'auto_summarize')
        
    Returns:
        Preference value
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        default_value = _PREFERENCE_DEFAULTS.get(preference_key)
        sentinel = object()

        # For canonical UI prefs, seed on first read (prevents 404 during bootstrap).
        if default_value is not None:
            value = await preferences_service.get_preference(
                preference_key=preference_key,
                user_id=user_id,
                default_value=sentinel,
            )
            if value is sentinel:
                success = await preferences_service.set_preference(
                    preference_key=preference_key,
                    preference_value=default_value,
                    user_id=user_id,
                )
                if not success:
                    # During onboarding, database is unavailable - return default without persisting
                    logger.debug(
                        "Failed to seed preference '%s' (database unavailable), returning default",
                        preference_key
                    )
                value = default_value
        else:
            value = await preferences_service.get_preference(
                preference_key=preference_key,
                user_id=user_id,
                default_value=None,
            )
            if value is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Preference '{preference_key}' not found for user '{user_id}'",
                )
        
        return PreferenceResponse(
            preference_key=preference_key,
            preference_value=value,
            user_id=user_id
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get preference %s: %s", preference_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve preference. Check server logs for details."
        )


@router.post("/{preference_key}", response_model=PreferenceResponse)
async def set_preference(
    preference_key: str,
    request: PreferenceValueRequest,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service)
) -> PreferenceResponse:
    """
    Set a user preference value (upsert).
    
    Args:
        preference_key: Preference identifier
        request: Preference value payload
        
    Returns:
        Updated preference
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        success = await preferences_service.set_preference(
            preference_key=preference_key,
            preference_value=request.value,
            user_id=user_id
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to set preference '{preference_key}'"
            )
        
        return PreferenceResponse(
            preference_key=preference_key,
            preference_value=request.value,
            user_id=user_id
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to set preference %s: %s", preference_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to set preference. Check server logs for details."
        )


@router.post(
    "/legal/acceptance",
    response_model=LegalAcceptanceResponse,
    summary="Record legal acceptance event",
    description="Writes append-only legal acceptance audit record and updates latest acceptance cache.",
)
async def record_legal_acceptance(
    request: LegalAcceptanceRequest,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service),
    database = Depends(get_database),
) -> LegalAcceptanceResponse:
    """
    Record legal acceptance as an append-only event and refresh latest cache.

    Source of truth: legal_acceptance_events table (append-only).
    Fast read cache: user_preferences.legal_acceptance_latest.
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        accepted_at = datetime.now(timezone.utc).isoformat()

        audit_record = {
            "user_id": user_id,
            "terms_version": request.terms_version.strip(),
            "terms_hash": request.terms_hash.strip(),
            "acceptance_method": request.acceptance_method.strip(),
            "app_version": request.app_version,
            "platform": request.platform,
            "source": request.source.strip(),
            "metadata": request.metadata or {},
            "accepted_at": accepted_at,
        }
        await database.insert("legal_acceptance_events", audit_record, admin=True)

        latest_snapshot = {
            "accepted": True,
            "terms_version": audit_record["terms_version"],
            "terms_hash": audit_record["terms_hash"],
            "accepted_at": accepted_at,
            "acceptance_method": audit_record["acceptance_method"],
            "source": audit_record["source"],
            "app_version": audit_record["app_version"],
            "platform": audit_record["platform"],
        }
        cache_saved = await preferences_service.set_preference(
            preference_key="legal_acceptance_latest",
            preference_value=latest_snapshot,
            user_id=user_id,
        )
        if not cache_saved:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Legal acceptance recorded, but cache update failed.",
            )

        return LegalAcceptanceResponse(
            accepted=True,
            user_id=user_id,
            terms_version=audit_record["terms_version"],
            terms_hash=audit_record["terms_hash"],
            accepted_at=accepted_at,
            acceptance_method=audit_record["acceptance_method"],
            source=audit_record["source"],
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to record legal acceptance: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to record legal acceptance. Check server logs for details."
        )


@router.get(
    "/legal/acceptance/latest",
    response_model=LegalAcceptanceResponse,
    summary="Get latest legal acceptance",
    description="Returns latest legal acceptance snapshot for current user.",
)
async def get_latest_legal_acceptance(
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service),
    database = Depends(get_database),
) -> LegalAcceptanceResponse:
    """Get the latest legal acceptance for the current user."""
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id

        rows = await database.select(
            table="legal_acceptance_events",
            filters={"user_id": user_id},
            order_by="accepted_at.desc",
            limit=1,
            admin=True,
        )
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No legal acceptance found for user '{user_id}'",
            )

        row = rows[0]
        latest_snapshot = {
            "accepted": True,
            "terms_version": str(row.get("terms_version") or ""),
            "terms_hash": str(row.get("terms_hash") or ""),
            "accepted_at": str(row.get("accepted_at") or ""),
            "acceptance_method": str(row.get("acceptance_method") or "checkbox"),
            "source": str(row.get("source") or "onboarding_modal"),
        }

        # Keep preference cache fresh, but do not fail read API on cache write errors.
        cached = await preferences_service.get_preference(
            preference_key="legal_acceptance_latest",
            user_id=user_id,
            default_value=None,
        )
        if not isinstance(cached, dict) or (
            cached.get("terms_version") != latest_snapshot["terms_version"]
            or cached.get("terms_hash") != latest_snapshot["terms_hash"]
            or str(cached.get("accepted_at") or "") != latest_snapshot["accepted_at"]
        ):
            cache_saved = await preferences_service.set_preference(
                preference_key="legal_acceptance_latest",
                preference_value=latest_snapshot,
                user_id=user_id,
            )
            if not cache_saved:
                logger.warning(
                    "Failed to refresh legal_acceptance_latest cache for user %s",
                    user_id,
                )

        return LegalAcceptanceResponse(
            accepted=latest_snapshot["accepted"],
            user_id=user_id,
            terms_version=latest_snapshot["terms_version"],
            terms_hash=latest_snapshot["terms_hash"],
            accepted_at=latest_snapshot["accepted_at"],
            acceptance_method=latest_snapshot["acceptance_method"],
            source=latest_snapshot["source"],
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to read latest legal acceptance: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to read legal acceptance. Check server logs for details."
        )


@router.delete(
    "/{preference_key}",
    summary="Delete a user preference",
    description="Removes a specific preference entry for the current user.",
)
async def delete_preference(
    preference_key: str,
    settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context),
    preferences_service: PreferencesService = Depends(get_preferences_service)
) -> Dict[str, Any]:
    """
    Delete a user preference.
    
    Args:
        preference_key: Preference identifier
        
    Returns:
        Success confirmation
    """
    try:
        user_id = _context.get("user_id") or settings.security.default_user_id
        success = await preferences_service.delete_preference(
            preference_key=preference_key,
            user_id=user_id
        )
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Preference '{preference_key}' not found"
            )
        
        return {
            "success": True,
            "message": f"Preference '{preference_key}' deleted successfully"
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete preference %s: %s", preference_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete preference. Check server logs for details."
        )
