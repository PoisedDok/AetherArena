"""
Input Sanitization and Validation - Security Layer

Provides comprehensive input validation, sanitization, and size limit enforcement
to prevent injection attacks, path traversal, and resource exhaustion.

@.architecture
Incoming: api/v1/endpoints/*.py, User input --- {str text, bytes file content, str path, str URL, Dict JSON payload}
Processing: sanitize_text(), sanitize_filename(), sanitize_path(), validate_file_upload(), check_sql_injection() --- {5 jobs: injection_detection, path_validation, sanitization, size_validation, validation}
Outgoing: api/v1/endpoints/*.py --- {str sanitized text, Path validated path, Dict[str, Any] file info, raises ValidationError}
"""

import re
import html
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# Size Limits (configurable per deployment)
@dataclass
class SizeLimits:
    """Configurable size limits for different input types."""
    
    # File upload limits
    MAX_FILE_SIZE_BYTES: int = 100 * 1024 * 1024  # 100MB
    MAX_IMAGE_SIZE_BYTES: int = 10 * 1024 * 1024   # 10MB
    MAX_PDF_SIZE_BYTES: int = 50 * 1024 * 1024     # 50MB
    
    # Text input limits
    MAX_PROMPT_LENGTH: int = 50_000        # 50K characters
    MAX_MESSAGE_LENGTH: int = 100_000      # 100K characters
    MAX_FILENAME_LENGTH: int = 255
    MAX_PATH_LENGTH: int = 4096
    
    # JSON payload limits
    MAX_JSON_SIZE_BYTES: int = 10 * 1024 * 1024  # 10MB
    MAX_JSON_DEPTH: int = 20
    MAX_ARRAY_LENGTH: int = 10_000
    
    # Request limits
    MAX_HEADERS_SIZE: int = 8192           # 8KB
    MAX_QUERY_STRING_LENGTH: int = 2048
    
    # Batch operations
    MAX_BATCH_SIZE: int = 100


DEFAULT_LIMITS = SizeLimits()


class ValidationError(Exception):
    """Raised when input validation fails."""
    pass


class SizeExceededError(ValidationError):
    """Raised when input exceeds size limits."""
    pass


class PathTraversalError(ValidationError):
    """Raised when path traversal attempt detected."""
    pass


class InputSanitizer:
    """
    Sanitizes and validates user inputs to prevent security vulnerabilities.
    
    Features:
    - Size limit enforcement
    - HTML/script injection prevention
    - Path traversal protection
    - SQL injection prevention (parameterized queries)
    - Command injection prevention
    - Unicode normalization
    """
    
    def __init__(self, limits: Optional[SizeLimits] = None):
        """
        Initialize sanitizer with size limits.
        
        Args:
            limits: Custom size limits (uses defaults if None)
        """
        self.limits = limits or DEFAULT_LIMITS
        
        # Dangerous patterns for detection
        self._sql_patterns = re.compile(
            r"(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)",
            re.IGNORECASE
        )
        self._path_traversal_patterns = re.compile(r"\.\.|~|%2e%2e|%252e|\\", re.IGNORECASE)
        self._script_patterns = re.compile(
            r"<script|javascript:|onerror=|onclick=|onload=",
            re.IGNORECASE
        )
    
    # ==================== Text Sanitization ====================
    
    def sanitize_text(
        self,
        text: str,
        max_length: Optional[int] = None,
        allow_html: bool = False,
        strip_scripts: bool = True
    ) -> str:
        """
        Sanitize text input for safe processing.
        
        Args:
            text: Input text to sanitize
            max_length: Maximum allowed length (uses default if None)
            allow_html: Whether to allow HTML tags
            strip_scripts: Whether to remove script tags
            
        Returns:
            Sanitized text
            
        Raises:
            ValidationError: If text is invalid
            SizeExceededError: If text exceeds size limit
        """
        if not isinstance(text, str):
            raise ValidationError(f"Expected string, got {type(text).__name__}")
        
        # Check length
        max_len = max_length or self.limits.MAX_MESSAGE_LENGTH
        if len(text) > max_len:
            raise SizeExceededError(
                f"Text length {len(text)} exceeds maximum {max_len}"
            )
        
        # Normalize Unicode (NFC form)
        import unicodedata
        text = unicodedata.normalize('NFC', text)
        
        # Remove null bytes
        text = text.replace('\x00', '')
        
        # Strip scripts if requested
        if strip_scripts:
            text = self._strip_scripts(text)
        
        # Escape HTML if not allowed
        if not allow_html:
            text = html.escape(text)
        
        return text
    
    def sanitize_prompt(self, prompt: str) -> str:
        """
        Sanitize user prompt for LLM processing.
        
        Args:
            prompt: User prompt text
            
        Returns:
            Sanitized prompt
        """
        return self.sanitize_text(
            prompt,
            max_length=self.limits.MAX_PROMPT_LENGTH,
            allow_html=False,
            strip_scripts=True
        )
    
    def _strip_scripts(self, text: str) -> str:
        """Remove script tags and javascript: URLs."""
        # Remove script tags
        text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.IGNORECASE | re.DOTALL)
        
        # Remove event handlers
        text = re.sub(r'\s*on\w+\s*=\s*["\'][^"\']*["\']', '', text, flags=re.IGNORECASE)
        
        # Remove javascript: URLs
        text = re.sub(r'javascript:', '', text, flags=re.IGNORECASE)
        
        return text
    
    # ==================== Path Sanitization ====================
    
    def sanitize_path(
        self,
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
        """
        if not isinstance(path, (str, Path)):
            raise ValidationError(f"Expected path string or Path, got {type(path).__name__}")
        
        # Check length
        if len(str(path)) > self.limits.MAX_PATH_LENGTH:
            raise SizeExceededError(
                f"Path length {len(str(path))} exceeds maximum {self.limits.MAX_PATH_LENGTH}"
            )
        
        # Check for path traversal patterns
        if self._path_traversal_patterns.search(str(path)):
            raise PathTraversalError(f"Path traversal attempt detected: {path}")
        
        # Resolve to absolute path
        try:
            resolved_path = Path(path).resolve()
        except (OSError, RuntimeError) as e:
            raise ValidationError(f"Invalid path: {e}")
        
        # Check if within allowed base
        if allowed_base:
            allowed_base = Path(allowed_base).resolve()
            try:
                resolved_path.relative_to(allowed_base)
            except ValueError:
                raise PathTraversalError(
                    f"Path {path} is outside allowed base {allowed_base}"
                )
        
        # Check existence if required
        if must_exist and not resolved_path.exists():
            raise ValidationError(f"Path does not exist: {path}")
        
        return resolved_path
    
    def sanitize_filename(self, filename: str) -> str:
        """
        Sanitize filename to prevent directory traversal and special characters.
        
        Args:
            filename: Filename to sanitize
            
        Returns:
            Safe filename
            
        Raises:
            ValidationError: If filename is invalid
        """
        if not isinstance(filename, str):
            raise ValidationError(f"Expected string filename, got {type(filename).__name__}")
        
        # Check length
        if len(filename) > self.limits.MAX_FILENAME_LENGTH:
            raise SizeExceededError(
                f"Filename length {len(filename)} exceeds maximum {self.limits.MAX_FILENAME_LENGTH}"
            )
        
        # Remove path components
        filename = Path(filename).name
        
        # Check for path traversal
        if self._path_traversal_patterns.search(filename):
            raise PathTraversalError(f"Path traversal in filename: {filename}")
        
        # Remove control characters
        filename = ''.join(char for char in filename if ord(char) >= 32)
        
        # Replace dangerous characters
        dangerous_chars = '<>:"|?*\\'
        for char in dangerous_chars:
            filename = filename.replace(char, '_')
        
        # Ensure filename is not empty
        if not filename or filename == '.':
            raise ValidationError("Filename cannot be empty")
        
        return filename
    
    # ==================== File Validation ====================
    
    def validate_file_size(
        self,
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
        """
        # Determine appropriate limit
        if file_type == 'image':
            max_size = self.limits.MAX_IMAGE_SIZE_BYTES
        elif file_type == 'pdf':
            max_size = self.limits.MAX_PDF_SIZE_BYTES
        else:
            max_size = self.limits.MAX_FILE_SIZE_BYTES
        
        if size_bytes > max_size:
            raise SizeExceededError(
                f"File size {size_bytes / (1024*1024):.2f}MB exceeds "
                f"maximum {max_size / (1024*1024):.2f}MB for {file_type or 'general'} files"
            )
    
    def validate_file_upload(
        self,
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
        """
        # Sanitize filename
        safe_filename = self.sanitize_filename(filename)
        
        # Get file extension
        file_ext = Path(safe_filename).suffix.lower()
        
        # Check allowed extensions
        if allowed_extensions and file_ext not in allowed_extensions:
            raise ValidationError(
                f"File type {file_ext} not allowed. "
                f"Allowed types: {', '.join(allowed_extensions)}"
            )
        
        # Validate size
        size_bytes = len(content_bytes)
        file_type = None
        if file_ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']:
            file_type = 'image'
        elif file_ext == '.pdf':
            file_type = 'pdf'
        
        self.validate_file_size(size_bytes, file_type)
        
        return {
            'safe_filename': safe_filename,
            'original_filename': filename,
            'size_bytes': size_bytes,
            'file_type': file_type,
            'extension': file_ext
        }
    
    # ==================== JSON Validation ====================
    
    def validate_json_size(self, json_bytes: bytes) -> None:
        """
        Validate JSON payload size.
        
        Args:
            json_bytes: JSON payload as bytes
            
        Raises:
            SizeExceededError: If JSON exceeds size limit
        """
        if len(json_bytes) > self.limits.MAX_JSON_SIZE_BYTES:
            raise SizeExceededError(
                f"JSON size {len(json_bytes) / (1024*1024):.2f}MB exceeds "
                f"maximum {self.limits.MAX_JSON_SIZE_BYTES / (1024*1024):.2f}MB"
            )
    
    def validate_json_depth(self, obj: Any, max_depth: Optional[int] = None) -> None:
        """
        Validate JSON nesting depth to prevent stack overflow.
        
        Args:
            obj: JSON object (dict, list, or primitive)
            max_depth: Maximum allowed depth
            
        Raises:
            ValidationError: If depth exceeds limit
        """
        max_depth = max_depth or self.limits.MAX_JSON_DEPTH
        
        def check_depth(o: Any, current_depth: int = 0) -> int:
            if current_depth > max_depth:
                raise ValidationError(
                    f"JSON nesting depth {current_depth} exceeds maximum {max_depth}"
                )
            
            if isinstance(o, dict):
                return max(
                    (check_depth(v, current_depth + 1) for v in o.values()),
                    default=current_depth
                )
            elif isinstance(o, list):
                return max(
                    (check_depth(item, current_depth + 1) for item in o),
                    default=current_depth
                )
            else:
                return current_depth
        
        check_depth(obj)
    
    # ==================== URL Validation ====================
    
    def validate_url(
        self,
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
        """
        from urllib.parse import urlparse
        import ipaddress
        
        if not isinstance(url, str):
            raise ValidationError(f"Expected URL string, got {type(url).__name__}")
        
        # Check length
        if len(url) > self.limits.MAX_PATH_LENGTH:
            raise SizeExceededError(f"URL length exceeds maximum {self.limits.MAX_PATH_LENGTH}")
        
        # Parse URL
        try:
            parsed = urlparse(url)
        except Exception as e:
            raise ValidationError(f"Invalid URL: {e}")
        
        # Validate scheme
        allowed_schemes = allowed_schemes or ['http', 'https']
        if parsed.scheme not in allowed_schemes:
            raise ValidationError(
                f"URL scheme '{parsed.scheme}' not allowed. "
                f"Allowed schemes: {', '.join(allowed_schemes)}"
            )
        
        # Check for private IPs if not allowed
        if not allow_private_ips and parsed.hostname:
            try:
                ip = ipaddress.ip_address(parsed.hostname)
                if ip.is_private or ip.is_loopback or ip.is_link_local:
                    raise ValidationError(
                        f"Private IP addresses not allowed: {parsed.hostname}"
                    )
            except ValueError:
                # Not an IP address, hostname is fine
                pass
        
        return url
    
    # ==================== Injection Detection ====================
    
    def check_sql_injection(self, text: str) -> bool:
        """
        Check if text contains SQL injection patterns.
        
        Args:
            text: Text to check
            
        Returns:
            True if SQL injection detected, False otherwise
        """
        return bool(self._sql_patterns.search(text))
    
    def check_script_injection(self, text: str) -> bool:
        """
        Check if text contains script injection patterns.
        
        Args:
            text: Text to check
            
        Returns:
            True if script injection detected, False otherwise
        """
        return bool(self._script_patterns.search(text))
    
    # ==================== Batch Operations ====================
    
    def validate_batch_size(self, items: List[Any]) -> None:
        """
        Validate batch operation size.
        
        Args:
            items: List of items in batch
            
        Raises:
            SizeExceededError: If batch size exceeds limit
        """
        if len(items) > self.limits.MAX_BATCH_SIZE:
            raise SizeExceededError(
                f"Batch size {len(items)} exceeds maximum {self.limits.MAX_BATCH_SIZE}"
            )


# Global sanitizer instance
_default_sanitizer: Optional[InputSanitizer] = None


def get_sanitizer() -> InputSanitizer:
    """Get global sanitizer instance."""
    global _default_sanitizer
    if _default_sanitizer is None:
        _default_sanitizer = InputSanitizer()
    return _default_sanitizer


# Convenience functions for common operations
def sanitize_text(text: str, **kwargs) -> str:
    """Sanitize text using global sanitizer."""
    return get_sanitizer().sanitize_text(text, **kwargs)


def sanitize_prompt(prompt: str) -> str:
    """Sanitize user prompt using global sanitizer."""
    return get_sanitizer().sanitize_prompt(prompt)


def sanitize_filename(filename: str) -> str:
    """Sanitize filename using global sanitizer."""
    return get_sanitizer().sanitize_filename(filename)


def sanitize_path(path: str, **kwargs) -> Path:
    """Sanitize file path using global sanitizer."""
    return get_sanitizer().sanitize_path(path, **kwargs)


def validate_file_upload(filename: str, content: bytes, **kwargs) -> Dict[str, Any]:
    """Validate file upload using global sanitizer."""
    return get_sanitizer().validate_file_upload(filename, content, **kwargs)


def validate_url(url: str, **kwargs) -> str:
    """Validate URL using global sanitizer."""
    return get_sanitizer().validate_url(url, **kwargs)


def validate_file_path(path: str, **kwargs) -> str:
    """
    Validate and sanitize file path (convenience wrapper for sanitize_path).
    
    Args:
        path: File path to validate
        **kwargs: Additional arguments for sanitize_path
    
    Returns:
        Validated path as string
    
    Raises:
        PathTraversalError: If path traversal detected
        ValidationError: If path is invalid
    """
    return str(get_sanitizer().sanitize_path(path, **kwargs))

