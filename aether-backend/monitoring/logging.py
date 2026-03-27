"""
Structured Logging

Configures JSON-formatted logging with trace correlation, context propagation, and request metadata.
Provides StructuredLogger, JSONFormatter, and context variable helpers.

@.architecture
Incoming: app.py, api/dependencies.py, all modules --- {log_config, request_id, correlation_id}
Processing: configure_logging(), set_request_context(), get_logger(), format_json() --- {2 jobs: JOB_LOAD_CONFIG, JOB_TRACE}
Outgoing: sys.stdout, log aggregation systems --- {StructuredLogger, JSON log records}
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
chat_id_ctx: ContextVar[Optional[str]] = ContextVar('chat_id', default=None)
frontend_id_ctx: ContextVar[Optional[str]] = ContextVar('frontend_id', default=None)
correlation_id_ctx: ContextVar[Optional[str]] = ContextVar('correlation_id', default=None)
operator_id_ctx: ContextVar[Optional[str]] = ContextVar('operator_id', default=None)


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
            chat_id = chat_id_ctx.get()
            frontend_id = frontend_id_ctx.get()
            correlation_id = correlation_id_ctx.get()
            operator_id = operator_id_ctx.get()
            
            if request_id:
                log_data['request_id'] = request_id
            if user_id:
                log_data['user_id'] = user_id
            if session_id:
                log_data['session_id'] = session_id
            if chat_id:
                log_data['chat_id'] = chat_id
            if frontend_id:
                log_data['frontend_id'] = frontend_id
            if correlation_id:
                log_data['correlation_id'] = correlation_id
            if operator_id:
                log_data['operator_id'] = operator_id
        
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
        record.chat_id = chat_id_ctx.get() or '-'
        record.frontend_id = frontend_id_ctx.get() or '-'
        record.correlation_id = correlation_id_ctx.get() or '-'
        record.operator_id = operator_id_ctx.get() or '-'
        return True


RESERVED_LOG_KWARGS = {'exc_info', 'stack_info', 'stacklevel', 'extra'}


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

    @property
    def name(self) -> str:
        """Expose underlying logger name for compatibility with stdlib Logger."""
        return self._logger.name
    
    def _log_with_context(
        self,
        level: int,
        message: str,
        *args: Any,
        **kwargs: Any
    ) -> None:
        """
        Log message with extra context.
        
        Args:
            level: Log level (logging.INFO, etc.)
            message: Log message
            **kwargs: Extra fields to include
        """
        logging_kwargs: Dict[str, Any] = {}
        structured_fields: Dict[str, Any] = {}

        for key, value in kwargs.items():
            if key in RESERVED_LOG_KWARGS:
                logging_kwargs[key] = value
            else:
                structured_fields[key] = value

        extra_payload = logging_kwargs.get('extra')
        if extra_payload is None:
            extra_payload = {}
        elif not isinstance(extra_payload, dict):
            extra_payload = {'value': extra_payload}

        if structured_fields:
            existing_structured = extra_payload.get('extra_fields', {})
            if not isinstance(existing_structured, dict):
                existing_structured = {}
            extra_payload = {
                **extra_payload,
                'extra_fields': {**existing_structured, **structured_fields},
            }

        if extra_payload:
            logging_kwargs['extra'] = extra_payload
        else:
            logging_kwargs.pop('extra', None)

        self._logger.log(level, message, *args, **logging_kwargs)
    
    def debug(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log debug message with context."""
        self._log_with_context(logging.DEBUG, message, *args, **kwargs)
    
    def info(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log info message with context."""
        self._log_with_context(logging.INFO, message, *args, **kwargs)
    
    def warning(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log warning message with context."""
        self._log_with_context(logging.WARNING, message, *args, **kwargs)
    
    def error(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log error message with context."""
        self._log_with_context(logging.ERROR, message, *args, **kwargs)
    
    def critical(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log critical message with context."""
        self._log_with_context(logging.CRITICAL, message, *args, **kwargs)
    
    def exception(self, message: str, *args: Any, **kwargs: Any) -> None:
        """Log exception with traceback."""
        kwargs.setdefault('exc_info', True)
        self._log_with_context(logging.ERROR, message, *args, **kwargs)


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
    # Normalize all application loggers under a single root namespace.
    normalized = (name or "aether").strip()
    if normalized != "aether" and not normalized.startswith("aether."):
        normalized = f"aether.{normalized}"
    return StructuredLogger(normalized)


def set_request_context(
    request_id: Optional[str] = None,
    user_id: Optional[str] = None,
    session_id: Optional[str] = None,
    chat_id: Optional[str] = None,
    frontend_id: Optional[str] = None,
    correlation_id: Optional[str] = None,
    operator_id: Optional[str] = None,
) -> None:
    """
    Set context variables for current request.
    
    Args:
        request_id: Unique request identifier
        user_id: User identifier
        session_id: Session identifier
        chat_id: Chat identifier
        frontend_id: Frontend instance identifier
        correlation_id: Correlation identifier spanning transports
        operator_id: Operator identity (maps to authenticated user)
    """
    if request_id:
        request_id_ctx.set(request_id)
    if user_id:
        user_id_ctx.set(user_id)
    if session_id:
        session_id_ctx.set(session_id)
    if chat_id:
        chat_id_ctx.set(chat_id)
    if frontend_id:
        frontend_id_ctx.set(frontend_id)
    if correlation_id:
        correlation_id_ctx.set(correlation_id)
    if operator_id:
        operator_id_ctx.set(operator_id)
    elif user_id:
        operator_id_ctx.set(user_id)


def clear_request_context() -> None:
    """Clear all context variables."""
    request_id_ctx.set(None)
    user_id_ctx.set(None)
    session_id_ctx.set(None)
    chat_id_ctx.set(None)
    frontend_id_ctx.set(None)
    correlation_id_ctx.set(None)
    operator_id_ctx.set(None)


def get_request_id() -> Optional[str]:
    """Get current request ID from context."""
    return request_id_ctx.get()


def get_user_id() -> Optional[str]:
    """Get current user ID from context."""
    return user_id_ctx.get()


def get_session_id() -> Optional[str]:
    """Get current session ID from context."""
    return session_id_ctx.get()


def get_chat_id() -> Optional[str]:
    """Get current chat ID from context."""
    return chat_id_ctx.get()


def get_frontend_id() -> Optional[str]:
    """Get current frontend ID from context."""
    return frontend_id_ctx.get()


def get_correlation_id() -> Optional[str]:
    """Get current correlation ID from context."""
    return correlation_id_ctx.get()


def get_operator_id() -> Optional[str]:
    """Get current operator ID from context."""
    return operator_id_ctx.get()


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

