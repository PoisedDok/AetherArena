"""
User Credentials Management Endpoints

Securely store and manage user-provided API keys and OAuth tokens (Google, Gmail, Outlook, etc.).

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST/DELETE) --- {HTTP requests to /v1/user-credentials/*}
Processing: save_credential(), list_credentials(), delete_credential() --- {JOB_HTTP_REQUEST, JOB_ENCRYPT, JOB_DECRYPT}
Outgoing: Database (user_settings), security.crypto (encryption), Frontend (HTTP) --- {Encrypted credentials saved/retrieved}
"""

from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from core.exceptions import DomainException
from api.dependencies import (
    setup_request_context,
    get_database,
)
from data.database.persistence_gateway import SupabasePersistenceGateway
from security.crypto import encrypt_secret, decrypt_secret
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(
    prefix="/user-credentials",
    tags=["user-credentials"],
)


# =============================================================================
# Schemas
# =============================================================================

class CredentialRequest(BaseModel):
    """Request to save a credential"""
    credential_key: str = Field(..., description="Unique key for the credential (e.g., 'google_oauth_token', 'gmail_api_key')")
    credential_value: str = Field(..., description="The credential value (will be encrypted)")
    description: Optional[str] = Field(None, description="Human-readable description")


class CredentialResponse(BaseModel):
    """Response for credential metadata (value is never returned)"""
    credential_key: str
    description: Optional[str]
    is_configured: bool
    updated_at: Optional[str]


class CredentialListResponse(BaseModel):
    """Response for listing all credentials"""
    credentials: List[CredentialResponse]


# =============================================================================
# Known Credential Types
# =============================================================================

KNOWN_CREDENTIALS = {
    "google_oauth_token": {
        "description": "Google OAuth token for email access",
        "type": "oauth_token"
    },
    "gmail_api_key": {
        "description": "Gmail API key (if not using OAuth)",
        "type": "api_key"
    },
    "outlook_oauth_token": {
        "description": "Outlook/Microsoft OAuth token for email",
        "type": "oauth_token"
    },
    "outlook_api_key": {
        "description": "Outlook API key (if not using OAuth)",
        "type": "api_key"
    },
    "weather_api_key": {
        "description": "Weather API key (OpenWeatherMap, etc.)",
        "type": "api_key"
    },
    "openai_api_key": {
        "description": "OpenAI API key (for GPT models)",
        "type": "api_key"
    },
    "anthropic_api_key": {
        "description": "Anthropic API key (for Claude models)",
        "type": "api_key"
    },
}


# =============================================================================
# Endpoints
# =============================================================================

@router.get(
    "/list",
    response_model=CredentialListResponse,
    summary="List all user credentials",
    description="Get metadata for all configured credentials (values are never returned)"
)
async def list_credentials(
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context)
) -> CredentialListResponse:
    """
    List all user credentials (metadata only, values are never returned).
    """
    try:
        # Fetch all credential entries from user_settings (setting_key starts with "credential_")
        # Note: Gateway doesn't support LIKE, so we fetch all and filter in Python
        all_settings = await gateway.select(
            "user_settings",
            columns="*",
            filters=None,
            admin=True  # Use service_role to bypass RLS
        )
        
        credentials = []
        
        # Filter and process credential entries
        for row in all_settings:
            if row["setting_key"].startswith("credential_"):
                key_name = row["setting_key"].replace("credential_", "")
                value = row.get("setting_value") or {}
                
                credentials.append(CredentialResponse(
                    credential_key=key_name,
                    description=value.get("description") or KNOWN_CREDENTIALS.get(key_name, {}).get("description"),
                    is_configured=True,
                    updated_at=row.get("updated_at")
                ))
        
        # Add known but unconfigured credentials
        configured_keys = {c.credential_key for c in credentials}
        for key, info in KNOWN_CREDENTIALS.items():
            if key not in configured_keys:
                credentials.append(CredentialResponse(
                    credential_key=key,
                    description=info["description"],
                    is_configured=False,
                    updated_at=None
                ))
        
        logger.info("Listed %s credentials (%s configured)", len(credentials), len([c for c in credentials if c.is_configured]))
        
        return CredentialListResponse(credentials=credentials)
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list credentials: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list credentials"
        )


@router.post(
    "/save",
    response_model=CredentialResponse,
    summary="Save a user credential",
    description="Securely save a user-provided API key or OAuth token (encrypted at rest)"
)
async def save_credential(
    credential: CredentialRequest,
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context)
) -> CredentialResponse:
    """
    Save a user credential securely (encrypted).
    """
    try:
        # Encrypt the credential value
        encrypted_value = encrypt_secret(credential.credential_value)
        
        # Store in user_settings table
        setting_key = f"credential_{credential.credential_key}"
        setting_value = {
            "encrypted_value": encrypted_value,
            "description": credential.description or KNOWN_CREDENTIALS.get(credential.credential_key, {}).get("description")
        }
        
        result = await gateway.upsert(
            "user_settings",
            {
                "setting_key": setting_key,
                "setting_value": setting_value
            },
            admin=True  # Use service_role to bypass RLS
        )
        
        if not result:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to save credential"
            )
        
        saved = result[0] if isinstance(result, list) else result
        
        logger.info("Saved credential: %s", credential.credential_key)
        
        return CredentialResponse(
            credential_key=credential.credential_key,
            description=setting_value["description"],
            is_configured=True,
            updated_at=saved.get("updated_at")
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to save credential %s: %s", credential.credential_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save credential. Check server logs for details."
        )


@router.delete(
    "/{credential_key}",
    summary="Delete a user credential",
    description="Remove a stored credential"
)
async def delete_credential(
    credential_key: str,
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Delete a user credential.
    """
    try:
        setting_key = f"credential_{credential_key}"
        
        await gateway.delete(
            "user_settings",
            record_id=setting_key,
            id_column="setting_key",
            admin=True,  # Use service_role to bypass RLS
        )
        
        logger.info("Deleted credential: %s", credential_key)
        
        return {
            "success": True,
            "credential_key": credential_key,
            "message": "Credential deleted successfully"
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete credential %s: %s", credential_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete credential"
        )


@router.get(
    "/{credential_key}/value",
    summary="Get decrypted credential value",
    description="Retrieve the decrypted value of a credential (use sparingly, only when needed by service)"
)
async def get_credential_value(
    credential_key: str,
    gateway: SupabasePersistenceGateway = Depends(get_database),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Get the decrypted value of a credential.
    
    WARNING: This endpoint returns the plaintext credential value.
    Only use when absolutely necessary (e.g., passing to external service).
    """
    try:
        setting_key = f"credential_{credential_key}"
        
        result = await gateway.select(
            "user_settings",
            columns="*",
            filters={"setting_key": setting_key},
            limit=1,
            admin=True  # Use service_role to bypass RLS
        )
        
        if not result or len(result) == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Credential '{credential_key}' not found"
            )
        
        row = result[0]
        setting_value = row.get("setting_value") or {}
        encrypted_value = setting_value.get("encrypted_value")
        
        if not encrypted_value:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Credential value is missing or corrupted"
            )
        
        # Decrypt the value
        decrypted_value = decrypt_secret(encrypted_value)
        
        logger.info("Retrieved credential value: %s", credential_key)
        
        return {
            "credential_key": credential_key,
            "value": decrypted_value
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to retrieve credential %s: %s", credential_key, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve credential"
        )
