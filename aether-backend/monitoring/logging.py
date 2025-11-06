"""
Structured Logging - Monitoring Layer

Provides production-ready structured logging with:
- JSON formatting for log aggregation
- Context injection (request ID, user ID, etc.)
- Correlation ID tracking across services
- Performance tracking
- Configurable log levels per module

@.architecture
Incoming: app.py, api/dependencies.py, All modules via get_logger() --- {str log_level, str format_type, Dict[str, str] module_levels, str request_id/user_id/session_id}
Processing: configure_logging(), JSONFormatter.format(), set_request_context(), StructuredLogger._log_with_context() --- {4 jobs: context_injection, formatting, log_configuration, structured_logging}
Outgoing: sys.stdout, Log files, All modules --- {StructuredLogger instances, JSON formatted logs, context variables}
"""

import logging
import logging.config
import json
import sys
import traceback
from datetime import datetime
from typing import Any, Dict, Optional
from contextvars import ContextVar
from pathlib import Path

# Context variables for request tracking
request_id_ctx: ContextVar[Optional[str]] = ContextVar('request_id', default=None)
user_id_ctx: ContextVar[Optional[str]] = ContextVar('user_id', default=None)
session_id_ctx: ContextVar[Optional[str]] = ContextVar('session_id', default=None)


class JSONFormatter(logging.Formatter):
    """
    JSON log formatter for structured logging.
    
    Outputs logs in JSON format for easy parsing by log aggregation systems
    (ELK, Splunk, CloudWatch, etc.)
    """
    
    def __init__(
        self,
        include_traceback: bool = True,
        include_context: bool = True
    ):
        """
        Initialize JSON formatter.
        
        Args:
            include_traceback: Include exception traceback in output
            include_context: Include context variables (request_id, user_id)
        """
        super().__init__()
        self.include_traceback = include_traceback
        self.include_context = include_context
    
    def format(self, record: logging.LogRecord) -> str:
        """
        Format log record as JSON.
        
        Args:
            record: Log record to format
            
        Returns:
            JSON string
        """
        log_data = {
            'timestamp': datetime.utcnow().isoformat() + 'Z',
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
            'module': record.module,
            'function': record.funcName,
            'line': record.lineno,
        }
        
        # Add context variables
        if self.include_context:
            request_id = request_id_ctx.get()
            user_id = user_id_ctx.get()
            session_id = session_id_ctx.get()
            
            if request_id:
                log_data['request_id'] = request_id
            if user_id:
                log_data['user_id'] = user_id
            if session_id:
                log_data['session_id'] = session_id
        
        # Add exception info
        if record.exc_info and self.include_traceback:
            log_data['exception'] = {
                'type': record.exc_info[0].__name__,
                'message': str(record.exc_info[1]),
                'traceback': traceback.format_exception(*record.exc_info)
            }
        
        # Add extra fields
        if hasattr(record, 'extra_fields'):
            log_data['extra'] = record.extra_fields
        
        return json.dumps(log_data, default=str)


class ContextFilter(logging.Filter):
    """
    Logging filter that adds context variables to log records.
    
    Useful for non-JSON formatters that still want context info.
    """
    
    def filter(self, record: logging.LogRecord) -> bool:
        """
        Add context to log record.
        
        Args:
            record: Log record
            
        Returns:
            True (always allow record through)
        """
        record.request_id = request_id_ctx.get() or '-'
        record.user_id = user_id_ctx.get() or '-'
        record.session_id = session_id_ctx.get() or '-'
        return True


class StructuredLogger:
    """
    Wrapper for Python logger with structured logging support.
    
    Provides convenience methods for logging with extra context.
    """
    
    def __init__(self, name: str):
        """
        Initialize structured logger.
        
        Args:
            name: Logger name (usually module name)
        """
        self._logger = logging.getLogger(name)
    
    def _log_with_context(
        self,
        level: int,
        message: str,
        **kwargs: Any
    ) -> None:
        """
        Log message with extra context.
        
        Args:
            level: Log level (logging.INFO, etc.)
            message: Log message
            **kwargs: Extra fields to include
        """
        # Create log record with extra fields
        extra = {'extra_fields': kwargs} if kwargs else {}
        self._logger.log(level, message, extra=extra)
    
    def debug(self, message: str, **kwargs: Any) -> None:
        """Log debug message with context."""
        self._log_with_context(logging.DEBUG, message, **kwargs)
    
    def info(self, message: str, **kwargs: Any) -> None:
        """Log info message with context."""
        self._log_with_context(logging.INFO, message, **kwargs)
    
    def warning(self, message: str, **kwargs: Any) -> None:
        """Log warning message with context."""
        self._log_with_context(logging.WARNING, message, **kwargs)
    
    def error(self, message: str, **kwargs: Any) -> None:
        """Log error message with context."""
        self._log_with_context(logging.ERROR, message, **kwargs)
    
    def critical(self, message: str, **kwargs: Any) -> None:
        """Log critical message with context."""
        self._log_with_context(logging.CRITICAL, message, **kwargs)
    
    def exception(self, message: str, **kwargs: Any) -> None:
        """Log exception with traceback."""
        self._logger.exception(message, extra={'extra_fields': kwargs} if kwargs else {})


def configure_logging(
    level: str = "INFO",
    format_type: str = "json",
    log_file: Optional[Path] = None,
    enable_console: bool = True,
    module_levels: Optional[Dict[str, str]] = None
) -> None:
    """
    Configure structured logging for the application.
    
    Args:
        level: Default log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        format_type: Output format ("json" or "text")
        log_file: Optional file path for log output
        enable_console: Enable console (stdout) logging
        module_levels: Per-module log levels (e.g. {"httpx": "WARNING"})
    """
    # Convert level string to logging constant
    log_level = getattr(logging, level.upper(), logging.INFO)
    
    # Create formatters
    if format_type == "json":
        formatter = JSONFormatter()
    else:
        # Text formatter with context
        formatter = logging.Formatter(
            fmt='%(asctime)s | %(levelname)-8s | %(name)-30s | [%(request_id)s] | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
    
    # Configure handlers
    handlers = []
    
    if enable_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        console_handler.addFilter(ContextFilter())
        handlers.append(console_handler)
    
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(formatter)
        file_handler.addFilter(ContextFilter())
        handlers.append(file_handler)
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(log_level)
    
    # Remove existing handlers
    root_logger.handlers = []
    
    # Add new handlers
    for handler in handlers:
        root_logger.addHandler(handler)
    
    # Configure module-specific levels
    if module_levels:
        for module_name, module_level in module_levels.items():
            module_log_level = getattr(logging, module_level.upper(), logging.INFO)
            logging.getLogger(module_name).setLevel(module_log_level)
    
    # Silence noisy libraries
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('httpcore').setLevel(logging.WARNING)
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)
    logging.getLogger('asyncio').setLevel(logging.WARNING)
    logging.getLogger('matplotlib').setLevel(logging.WARNING)
    logging.getLogger('matplotlib.font_manager').setLevel(logging.WARNING)
    
    # Silence LiteLLM completely - extremely noisy
    logging.getLogger('LiteLLM').setLevel(logging.ERROR)
    logging.getLogger('litellm').setLevel(logging.ERROR)
    logging.getLogger('openai').setLevel(logging.ERROR)
    logging.getLogger('openai._base_client').setLevel(logging.ERROR)


def get_logger(name: str) -> StructuredLogger:
    """
    Get structured logger for module.
    
    Args:
        name: Logger name (usually __name__)
        
    Returns:
        StructuredLogger instance
    """
    return StructuredLogger(name)


def set_request_context(
    request_id: Optional[str] = None,
    user_id: Optional[str] = None,
    session_id: Optional[str] = None
) -> None:
    """
    Set context variables for current request.
    
    Args:
        request_id: Unique request identifier
        user_id: User identifier
        session_id: Session identifier
    """
    if request_id:
        request_id_ctx.set(request_id)
    if user_id:
        user_id_ctx.set(user_id)
    if session_id:
        session_id_ctx.set(session_id)


def clear_request_context() -> None:
    """Clear all context variables."""
    request_id_ctx.set(None)
    user_id_ctx.set(None)
    session_id_ctx.set(None)


def get_request_id() -> Optional[str]:
    """Get current request ID from context."""
    return request_id_ctx.get()


def get_user_id() -> Optional[str]:
    """Get current user ID from context."""
    return user_id_ctx.get()


def get_session_id() -> Optional[str]:
    """Get current session ID from context."""
    return session_id_ctx.get()


# Default configuration presets
LOGGING_PRESETS = {
    'development': {
        'level': 'INFO',  # Changed from DEBUG to reduce noise
        'format_type': 'text',
        'enable_console': True,
        'module_levels': {
            'httpx': 'WARNING',
            'httpcore': 'WARNING',
            'asyncio': 'WARNING',
            'matplotlib': 'WARNING',
            'LiteLLM': 'ERROR',
            'litellm': 'ERROR',
            'openai': 'ERROR',
        }
    },
    'production': {
        'level': 'INFO',
        'format_type': 'json',
        'enable_console': True,
        'module_levels': {
            'httpx': 'WARNING',
            'httpcore': 'WARNING',
            'uvicorn.access': 'WARNING',
            'asyncio': 'WARNING',
            'matplotlib': 'WARNING',
            'LiteLLM': 'ERROR',
            'litellm': 'ERROR',
            'openai': 'ERROR',
        }
    },
    'testing': {
        'level': 'WARNING',
        'format_type': 'text',
        'enable_console': True,
        'module_levels': {
            'LiteLLM': 'ERROR',
            'litellm': 'ERROR',
            'openai': 'ERROR',
        }
    }
}


def configure_from_preset(preset: str = 'development', **overrides: Any) -> None:
    """
    Configure logging from preset.
    
    Args:
        preset: Preset name ('development', 'production', or 'testing')
        **overrides: Override preset values
    """
    if preset not in LOGGING_PRESETS:
        raise ValueError(f"Unknown preset: {preset}. Available: {list(LOGGING_PRESETS.keys())}")
    
    config = LOGGING_PRESETS[preset].copy()
    config.update(overrides)
    
    configure_logging(**config)

