# Incoming: none --- {none, none}
# Processing: none --- {0 jobs: none}
# Outgoing: none --- {none, none}
"""
Utilities Package - Production-ready helper modules.

Provides convenient wrappers and utilities for common operations:
- crypto: Encryption, hashing, token generation
- http: HTTP client with retry and timeout management
- validation: Input validation and sanitization
- config: Configuration loading
"""

from .crypto import (
    encrypt,
    decrypt,
    hash_password,
    verify_password,
    generate_token,
    generate_api_key,
    hash_token,
    checksum_file,
    CryptoError,
)

from .validation import (
    sanitize_text,
    sanitize_prompt,
    sanitize_filename,
    sanitize_path,
    validate_file_upload,
    validate_file_size,
    validate_url,
    validate_json_depth,
    validate_batch_size,
    check_sql_injection,
    check_script_injection,
    ValidationError,
    SizeExceededError,
    PathTraversalError,
)

from .config import (
    load_config,
    get_llm_settings,
    get_provider_url,
)

__all__ = [
    # Crypto
    'encrypt',
    'decrypt',
    'hash_password',
    'verify_password',
    'generate_token',
    'generate_api_key',
    'hash_token',
    'checksum_file',
    'CryptoError',
    
    # Validation
    'sanitize_text',
    'sanitize_prompt',
    'sanitize_filename',
    'sanitize_path',
    'validate_file_upload',
    'validate_file_size',
    'validate_url',
    'validate_json_depth',
    'validate_batch_size',
    'check_sql_injection',
    'check_script_injection',
    'ValidationError',
    'SizeExceededError',
    'PathTraversalError',
    
    # Config
    'load_config',
    'get_llm_settings',
    'get_provider_url',
    
]

