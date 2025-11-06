"""
Validation Utilities - Convenience wrappers for security layer.

Provides simple functions for common validation operations by wrapping
the comprehensive security.sanitization module. Used across the backend
for quick input validation and sanitization.

@.architecture
Incoming: All backend modules, security/sanitization.py --- {str text, str filename, str path, bytes file_content, str URL, Dict JSON, List batch}
Processing: sanitize_text(), sanitize_filename(), validate_file_upload(), validate_url(), check_sql_injection() --- {5 jobs: delegation, injection_detection, path_validation, sanitization, validation}
Outgoing: All backend modules --- {str sanitized text, Path validated path, Dict[str, Any] file info, bool injection detected, raises ValidationError}
"""

from pathlib import Path
from typing import Any, Dict, List, Optional

# Import security layer components
from security.sanitization import (
    ValidationError,
    SizeExceededError,
    PathTraversalError,
    InputSanitizer,
    SizeLimits,
    get_sanitizer,
)

__all__ = [
    # Exceptions
    'ValidationError',
    'SizeExceededError',
    'PathTraversalError',
    
    # Classes
    'InputSanitizer',
    'SizeLimits',
    
    # Convenience functions
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
    'get_sanitizer',
]


# =============================================================================
# Text Sanitization
# =============================================================================

def sanitize_text(
    text: str,
    max_length: Optional[int] = None,
    allow_html: bool = False,
    strip_scripts: bool = True
) -> str:
    """
    Sanitize text input for safe processing.
    
    Args:
        text: Input text to sanitize
        max_length: Maximum allowed length
        allow_html: Whether to allow HTML tags
        strip_scripts: Whether to remove script tags
        
    Returns:
        Sanitized text
        
    Raises:
        ValidationError: If text is invalid
        SizeExceededError: If text exceeds size limit
        
    Example:
        >>> safe_text = sanitize_text(user_input, max_length=1000)
    """
    sanitizer = get_sanitizer()
    return sanitizer.sanitize_text(
        text,
        max_length=max_length,
        allow_html=allow_html,
        strip_scripts=strip_scripts
    )


def sanitize_prompt(prompt: str) -> str:
    """
    Sanitize user prompt for LLM processing.
    
    Args:
        prompt: User prompt text
        
    Returns:
        Sanitized prompt
        
    Example:
        >>> safe_prompt = sanitize_prompt(user_prompt)
        >>> response = await llm.chat(safe_prompt)
    """
    sanitizer = get_sanitizer()
    return sanitizer.sanitize_prompt(prompt)


# =============================================================================
# Path Sanitization
# =============================================================================

def sanitize_filename(filename: str) -> str:
    """
    Sanitize filename to prevent directory traversal and special characters.
    
    Args:
        filename: Filename to sanitize
        
    Returns:
        Safe filename
        
    Raises:
        ValidationError: If filename is invalid
        PathTraversalError: If path traversal detected
        
    Example:
        >>> safe_name = sanitize_filename("../../etc/passwd")  # Raises error
        >>> safe_name = sanitize_filename("document.pdf")  # Returns "document.pdf"
    """
    sanitizer = get_sanitizer()
    return sanitizer.sanitize_filename(filename)


def sanitize_path(
    path: str,
    allowed_base: Optional[Path] = None,
    must_exist: bool = False
) -> Path:
    """
    Sanitize file path to prevent directory traversal attacks.
    
    Args:
        path: File path to sanitize
        allowed_base: Base directory path must be within
        must_exist: Whether path must exist
        
    Returns:
        Resolved absolute Path object
        
    Raises:
        PathTraversalError: If path escapes allowed base
        ValidationError: If path is invalid
        
    Example:
        >>> safe_path = sanitize_path("uploads/file.pdf", allowed_base=Path("./data"))
    """
    sanitizer = get_sanitizer()
    return sanitizer.sanitize_path(path, allowed_base=allowed_base, must_exist=must_exist)


# =============================================================================
# File Validation
# =============================================================================

def validate_file_upload(
    filename: str,
    content_bytes: bytes,
    allowed_extensions: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Comprehensive file upload validation.
    
    Args:
        filename: Original filename
        content_bytes: File content
        allowed_extensions: List of allowed extensions (e.g., ['.pdf', '.png'])
        
    Returns:
        Dict with safe_filename and file_info
        
    Raises:
        ValidationError: If file validation fails
        SizeExceededError: If file exceeds size limit
        
    Example:
        >>> file_info = validate_file_upload(
        ...     "document.pdf",
        ...     file_bytes,
        ...     allowed_extensions=['.pdf', '.doc']
        ... )
        >>> # Returns: {'safe_filename': 'document.pdf', 'size_bytes': 12345, ...}
    """
    sanitizer = get_sanitizer()
    return sanitizer.validate_file_upload(filename, content_bytes, allowed_extensions)


def validate_file_size(
    size_bytes: int,
    file_type: Optional[str] = None
) -> None:
    """
    Validate file size against limits.
    
    Args:
        size_bytes: File size in bytes
        file_type: File type (image, pdf, or None for general)
        
    Raises:
        SizeExceededError: If file exceeds size limit
        
    Example:
        >>> validate_file_size(len(file_bytes), file_type='image')
    """
    sanitizer = get_sanitizer()
    sanitizer.validate_file_size(size_bytes, file_type=file_type)


# =============================================================================
# URL Validation
# =============================================================================

def validate_url(
    url: str,
    allowed_schemes: Optional[List[str]] = None,
    allow_private_ips: bool = False
) -> str:
    """
    Validate URL for safety.
    
    Args:
        url: URL to validate
        allowed_schemes: Allowed URL schemes (default: ['http', 'https'])
        allow_private_ips: Whether to allow private IP addresses
        
    Returns:
        Validated URL
        
    Raises:
        ValidationError: If URL is invalid or unsafe
        
    Example:
        >>> safe_url = validate_url("https://example.com/api")
        >>> # Internal IPs blocked by default
        >>> validate_url("http://192.168.1.1")  # Raises error
    """
    sanitizer = get_sanitizer()
    return sanitizer.validate_url(
        url,
        allowed_schemes=allowed_schemes,
        allow_private_ips=allow_private_ips
    )


# =============================================================================
# JSON Validation
# =============================================================================

def validate_json_depth(obj: Any, max_depth: Optional[int] = None) -> None:
    """
    Validate JSON nesting depth to prevent stack overflow.
    
    Args:
        obj: JSON object (dict, list, or primitive)
        max_depth: Maximum allowed depth (default from limits)
        
    Raises:
        ValidationError: If depth exceeds limit
        
    Example:
        >>> validate_json_depth({"a": {"b": {"c": "value"}}})  # OK
        >>> deeply_nested = {"a": {...}}  # 100 levels deep
        >>> validate_json_depth(deeply_nested)  # Raises error
    """
    sanitizer = get_sanitizer()
    sanitizer.validate_json_depth(obj, max_depth=max_depth)


def validate_json_size(json_bytes: bytes) -> None:
    """
    Validate JSON payload size.
    
    Args:
        json_bytes: JSON payload as bytes
        
    Raises:
        SizeExceededError: If JSON exceeds size limit
    """
    sanitizer = get_sanitizer()
    sanitizer.validate_json_size(json_bytes)


# =============================================================================
# Batch Operations
# =============================================================================

def validate_batch_size(items: List[Any]) -> None:
    """
    Validate batch operation size.
    
    Args:
        items: List of items in batch
        
    Raises:
        SizeExceededError: If batch size exceeds limit
        
    Example:
        >>> validate_batch_size(file_list)  # Checks count
    """
    sanitizer = get_sanitizer()
    sanitizer.validate_batch_size(items)


# =============================================================================
# Injection Detection
# =============================================================================

def check_sql_injection(text: str) -> bool:
    """
    Check if text contains SQL injection patterns.
    
    Args:
        text: Text to check
        
    Returns:
        True if SQL injection detected, False otherwise
        
    Example:
        >>> if check_sql_injection(user_input):
        ...     logger.warning("SQL injection attempt detected")
        ...     raise ValidationError("Invalid input")
    """
    sanitizer = get_sanitizer()
    return sanitizer.check_sql_injection(text)


def check_script_injection(text: str) -> bool:
    """
    Check if text contains script injection patterns.
    
    Args:
        text: Text to check
        
    Returns:
        True if script injection detected, False otherwise
        
    Example:
        >>> if check_script_injection(user_html):
        ...     logger.warning("Script injection attempt detected")
        ...     raise ValidationError("Invalid HTML")
    """
    sanitizer = get_sanitizer()
    return sanitizer.check_script_injection(text)


# =============================================================================
# Custom Size Limits
# =============================================================================

def create_custom_sanitizer(limits: SizeLimits) -> InputSanitizer:
    """
    Create sanitizer with custom size limits.
    
    Args:
        limits: Custom size limits
        
    Returns:
        InputSanitizer with custom configuration
        
    Example:
        >>> custom_limits = SizeLimits(
        ...     MAX_FILE_SIZE_BYTES=200 * 1024 * 1024,  # 200MB
        ...     MAX_PROMPT_LENGTH=100_000
        ... )
        >>> custom_sanitizer = create_custom_sanitizer(custom_limits)
    """
    return InputSanitizer(limits=limits)

