"""
Security Layer - Production-Ready Security Framework

Provides comprehensive security features for the Aether backend including:
- Input sanitization and validation
- Encryption and hashing
- Rate limiting
- Authentication and authorization
- Access control

All modules follow security best practices and are production-ready.
"""

# Sanitization and validation
from .sanitization import (
    InputSanitizer,
    SizeLimits,
    ValidationError,
    SizeExceededError,
    PathTraversalError,
    get_sanitizer,
    sanitize_text,
    sanitize_prompt,
    sanitize_filename,
    sanitize_path,
    validate_file_upload,
    validate_url,
)

# Cryptography
from .crypto import (
    EncryptionManager,
    Hasher,
    SecretManager,
    CryptoError,
    get_secret_manager,
    encrypt_secret,
    decrypt_secret,
    hash_password,
    verify_password,
    generate_token,
    generate_api_key,
    verify_api_key,
)

# Rate limiting
from .rate_limit import (
    RateLimiter,
    RateLimitConfig,
    RateLimitStrategy,
    RateLimitExceeded,
    MultiTierRateLimiter,
    get_rate_limiter,
    check_rate_limit,
    get_limit_info,
)

# Permissions and authorization
from .permissions import (
    Permission,
    Role,
    RoleDefinition,
    PermissionManager,
    User,
    AuthorizationContext,
    PermissionError,
    get_permission_manager,
    has_permission,
    check_permission,
    get_role_permissions,
)

# Authentication
from .auth import (
    AuthenticationManager,
    AuthConfig,
    AuthenticationError,
    InvalidTokenError,
    ExpiredTokenError,
    get_auth_manager,
    authenticate_request,
    validate_api_key as auth_validate_api_key,
    generate_api_key as auth_generate_api_key,
    revoke_api_key,
)

__all__ = [
    # Sanitization
    'InputSanitizer',
    'SizeLimits',
    'ValidationError',
    'SizeExceededError',
    'PathTraversalError',
    'get_sanitizer',
    'sanitize_text',
    'sanitize_prompt',
    'sanitize_filename',
    'sanitize_path',
    'validate_file_upload',
    'validate_url',
    
    # Crypto
    'EncryptionManager',
    'Hasher',
    'SecretManager',
    'CryptoError',
    'get_secret_manager',
    'encrypt_secret',
    'decrypt_secret',
    'hash_password',
    'verify_password',
    'generate_token',
    'generate_api_key',
    'verify_api_key',
    
    # Rate limiting
    'RateLimiter',
    'RateLimitConfig',
    'RateLimitStrategy',
    'RateLimitExceeded',
    'MultiTierRateLimiter',
    'get_rate_limiter',
    'check_rate_limit',
    'get_limit_info',
    
    # Permissions
    'Permission',
    'Role',
    'RoleDefinition',
    'PermissionManager',
    'User',
    'AuthorizationContext',
    'PermissionError',
    'get_permission_manager',
    'has_permission',
    'check_permission',
    'get_role_permissions',
    
    # Authentication
    'AuthenticationManager',
    'AuthConfig',
    'AuthenticationError',
    'InvalidTokenError',
    'ExpiredTokenError',
    'get_auth_manager',
    'authenticate_request',
    'auth_validate_api_key',
    'auth_generate_api_key',
    'revoke_api_key',
]

