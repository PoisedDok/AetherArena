"""
Authentication - Security Layer

@.architecture
Incoming: security/crypto.py, security/permissions.py, api/dependencies.py (optional), API requests --- {Hasher, SecretManager, PermissionManager, X-API-Key header, Bearer token, authentication requests}
Processing: register_api_key(), revoke_api_key(), validate_api_key(), generate_token(), validate_token(), revoke_token(), authenticate_request(), create_user_session(), cleanup_expired_tokens(), get_statistics(), list_api_keys(), get_auth_manager() --- {9 jobs: api_key_management, authentication, cleanup, expiry_handling, initialization, session_management, statistics, token_management, validation}
Outgoing: security/permissions.py, api/dependencies.py, in-memory storage --- {AuthorizationContext, User object, in-memory _api_keys/_tokens dicts}

Provides authentication mechanisms including API key validation, token management,
and session handling for securing API access.
"""

import logging
from typing import Optional, Dict, Any
from datetime import datetime, timedelta
from dataclasses import dataclass

from .crypto import Hasher, get_secret_manager
from .permissions import User, Role, AuthorizationContext, get_permission_manager

logger = logging.getLogger(__name__)


class AuthenticationError(Exception):
    """Raised when authentication fails."""
    pass


class InvalidTokenError(AuthenticationError):
    """Raised when token is invalid."""
    pass


class ExpiredTokenError(AuthenticationError):
    """Raised when token has expired."""
    pass


@dataclass
class AuthConfig:
    """Authentication configuration."""
    
    # API key settings
    require_api_key: bool = False
    api_key_header: str = "X-API-Key"
    
    # Token settings
    token_expiry_hours: int = 24
    allow_bearer_tokens: bool = True
    
    # Session settings
    session_enabled: bool = False
    session_cookie_name: str = "aether_session"
    session_expiry_hours: int = 24
    
    # Security
    allow_anonymous: bool = True
    default_role: str = Role.USER


class AuthenticationManager:
    """
    Manages authentication with support for API keys and tokens.
    
    Features:
    - API key validation
    - Token generation and validation
    - User identity management
    - Anonymous access control
    """
    
    def __init__(self, config: Optional[AuthConfig] = None):
        """
        Initialize authentication manager.
        
        Args:
            config: Authentication configuration
        """
        self.config = config or AuthConfig()
        self._secret_manager = get_secret_manager()
        self._hasher = Hasher()
        self._perm_manager = get_permission_manager()
        
        # Storage for API keys (in production, use database)
        self._api_keys: Dict[str, Dict[str, Any]] = {}
        
        # Storage for active tokens (in production, use Redis/database)
        self._tokens: Dict[str, Dict[str, Any]] = {}
    
    # ==================== API Key Management ====================
    
    def register_api_key(
        self,
        user_id: str,
        role: str = Role.USER,
        description: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Generate and register new API key for user.
        
        Args:
            user_id: User identifier
            role: User role
            description: Key description
            metadata: Additional metadata
            
        Returns:
            Generated API key (show only once to user)
        """
        # Generate API key
        api_key = self._hasher.generate_api_key(prefix="aether")
        api_key_hash = self._hasher.hash_token(api_key)
        
        # Store hashed key with user info
        self._api_keys[api_key_hash] = {
            'user_id': user_id,
            'role': role,
            'description': description,
            'metadata': metadata or {},
            'created_at': datetime.now().isoformat(),
            'last_used': None,
            'enabled': True
        }
        
        logger.info(f"Registered API key for user '{user_id}' with role '{role}'")
        return api_key
    
    def revoke_api_key(self, api_key: str) -> None:
        """
        Revoke API key.
        
        Args:
            api_key: API key to revoke
        """
        api_key_hash = self._hasher.hash_token(api_key)
        
        if api_key_hash in self._api_keys:
            self._api_keys[api_key_hash]['enabled'] = False
            logger.info(f"Revoked API key for user '{self._api_keys[api_key_hash]['user_id']}'")
        else:
            logger.warning(f"Attempted to revoke unknown API key")
    
    def validate_api_key(self, api_key: str) -> User:
        """
        Validate API key and return user.
        
        Args:
            api_key: API key to validate
            
        Returns:
            User object
            
        Raises:
            AuthenticationError: If API key invalid or disabled
        """
        api_key_hash = self._hasher.hash_token(api_key)
        
        if api_key_hash not in self._api_keys:
            raise AuthenticationError("Invalid API key")
        
        key_info = self._api_keys[api_key_hash]
        
        if not key_info['enabled']:
            raise AuthenticationError("API key revoked")
        
        # Update last used timestamp
        key_info['last_used'] = datetime.now().isoformat()
        
        # Create user object
        user = User(
            user_id=key_info['user_id'],
            role=key_info['role'],
            metadata=key_info['metadata']
        )
        
        logger.debug(f"Validated API key for user '{user.user_id}'")
        return user
    
    # ==================== Token Management ====================
    
    def generate_token(
        self,
        user_id: str,
        role: str = Role.USER,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Generate temporary access token.
        
        Args:
            user_id: User identifier
            role: User role
            metadata: Additional metadata
            
        Returns:
            Access token
        """
        # Generate token
        token = self._hasher.generate_token(length=32)
        
        # Store token with expiry
        expiry = datetime.now() + timedelta(hours=self.config.token_expiry_hours)
        self._tokens[token] = {
            'user_id': user_id,
            'role': role,
            'metadata': metadata or {},
            'created_at': datetime.now().isoformat(),
            'expires_at': expiry.isoformat(),
            'last_used': None
        }
        
        logger.info(f"Generated token for user '{user_id}' (expires: {expiry})")
        return token
    
    def validate_token(self, token: str) -> User:
        """
        Validate access token and return user.
        
        Args:
            token: Access token to validate
            
        Returns:
            User object
            
        Raises:
            InvalidTokenError: If token invalid
            ExpiredTokenError: If token expired
        """
        if token not in self._tokens:
            raise InvalidTokenError("Invalid token")
        
        token_info = self._tokens[token]
        
        # Check expiry
        expires_at = datetime.fromisoformat(token_info['expires_at'])
        if datetime.now() > expires_at:
            # Clean up expired token
            del self._tokens[token]
            raise ExpiredTokenError("Token expired")
        
        # Update last used
        token_info['last_used'] = datetime.now().isoformat()
        
        # Create user object
        user = User(
            user_id=token_info['user_id'],
            role=token_info['role'],
            metadata=token_info['metadata']
        )
        
        logger.debug(f"Validated token for user '{user.user_id}'")
        return user
    
    def revoke_token(self, token: str) -> None:
        """Revoke access token."""
        if token in self._tokens:
            user_id = self._tokens[token]['user_id']
            del self._tokens[token]
            logger.info(f"Revoked token for user '{user_id}'")
    
    # ==================== Authentication ====================
    
    def authenticate_request(
        self,
        api_key: Optional[str] = None,
        bearer_token: Optional[str] = None
    ) -> AuthorizationContext:
        """
        Authenticate request and return authorization context.
        
        Args:
            api_key: API key from header
            bearer_token: Bearer token from Authorization header
            
        Returns:
            AuthorizationContext for the authenticated user
            
        Raises:
            AuthenticationError: If authentication required but fails
        """
        # Try API key authentication
        if api_key:
            try:
                user = self.validate_api_key(api_key)
                return AuthorizationContext(user, self._perm_manager)
            except AuthenticationError as e:
                logger.warning(f"API key authentication failed: {e}")
                if self.config.require_api_key:
                    raise
        
        # Try bearer token authentication
        if bearer_token and self.config.allow_bearer_tokens:
            try:
                user = self.validate_token(bearer_token)
                return AuthorizationContext(user, self._perm_manager)
            except AuthenticationError as e:
                logger.warning(f"Token authentication failed: {e}")
                if self.config.require_api_key:
                    raise
        
        # Anonymous access
        if self.config.allow_anonymous:
            anonymous_user = User(
                user_id="anonymous",
                role=Role.ANONYMOUS,
                metadata={'authenticated': False}
            )
            return AuthorizationContext(anonymous_user, self._perm_manager)
        else:
            raise AuthenticationError("Authentication required")
    
    def create_user_session(
        self,
        user_id: str,
        role: str = Role.USER,
        metadata: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        Create authenticated user session.
        
        Args:
            user_id: User identifier
            role: User role
            metadata: Additional metadata
            
        Returns:
            Session token
        """
        # For now, use token-based sessions
        # In production, implement proper session management with Redis/database
        return self.generate_token(user_id, role, metadata)
    
    # ==================== Utilities ====================
    
    def cleanup_expired_tokens(self) -> int:
        """
        Remove expired tokens from storage.
        
        Returns:
            Number of tokens cleaned up
        """
        now = datetime.now()
        expired_tokens = [
            token
            for token, info in self._tokens.items()
            if datetime.fromisoformat(info['expires_at']) < now
        ]
        
        for token in expired_tokens:
            del self._tokens[token]
        
        if expired_tokens:
            logger.info(f"Cleaned up {len(expired_tokens)} expired tokens")
        
        return len(expired_tokens)
    
    def get_statistics(self) -> Dict[str, Any]:
        """Get authentication statistics."""
        active_tokens = len(self._tokens)
        active_api_keys = sum(1 for info in self._api_keys.values() if info['enabled'])
        
        return {
            'active_api_keys': active_api_keys,
            'total_api_keys': len(self._api_keys),
            'active_tokens': active_tokens,
            'config': {
                'require_api_key': self.config.require_api_key,
                'allow_anonymous': self.config.allow_anonymous,
                'token_expiry_hours': self.config.token_expiry_hours
            }
        }
    
    def list_api_keys(self, user_id: Optional[str] = None) -> list[Dict[str, Any]]:
        """
        List API keys (optionally filtered by user).
        
        Args:
            user_id: Filter by user ID
            
        Returns:
            List of API key info (without key itself)
        """
        keys = []
        for key_hash, info in self._api_keys.items():
            if user_id is None or info['user_id'] == user_id:
                # Return sanitized info (no key hash)
                keys.append({
                    'user_id': info['user_id'],
                    'role': info['role'],
                    'description': info['description'],
                    'created_at': info['created_at'],
                    'last_used': info['last_used'],
                    'enabled': info['enabled']
                })
        return keys


# Global authentication manager instance
_auth_manager: Optional[AuthenticationManager] = None


def get_auth_manager(config: Optional[AuthConfig] = None) -> AuthenticationManager:
    """Get global authentication manager."""
    global _auth_manager
    if _auth_manager is None:
        _auth_manager = AuthenticationManager(config)
    return _auth_manager


# Convenience functions
def authenticate_request(
    api_key: Optional[str] = None,
    bearer_token: Optional[str] = None
) -> AuthorizationContext:
    """Authenticate request using global manager."""
    return get_auth_manager().authenticate_request(api_key, bearer_token)


def validate_api_key(api_key: str) -> User:
    """Validate API key using global manager."""
    return get_auth_manager().validate_api_key(api_key)


def generate_api_key(
    user_id: str,
    role: str = Role.USER,
    description: Optional[str] = None
) -> str:
    """Generate API key using global manager."""
    return get_auth_manager().register_api_key(user_id, role, description)


def revoke_api_key(api_key: str) -> None:
    """Revoke API key using global manager."""
    get_auth_manager().revoke_api_key(api_key)

