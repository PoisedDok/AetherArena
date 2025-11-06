"""
Production-Ready Runtime System for Aether Backend

Consolidated from 20+ modular files into 6 focused, secure, production-ready modules.
This runtime orchestrates Open Interpreter integration, document processing, streaming chat,
and external service integrations with complete error handling and resource management.

Core Modules:
- engine.py: Main runtime orchestrator (replaces oi_runtime + factory)
- interpreter.py: Open Interpreter lifecycle management
- streaming.py: Chat streaming with OI and HTTP fallback
- document.py: File processing and analysis
- request.py: Request tracking and cancellation
- config.py: Configuration and HTTP client management

Features:
- Dependency injection with proper lifecycle management
- Async-safe with proper lock management
- Complete error handling and recovery
- Resource cleanup on shutdown
- Health monitoring and diagnostics
- Production-grade logging and observability
"""

from .engine import RuntimeEngine
from .interpreter import InterpreterManager
from .streaming import ChatStreamer
from .document import DocumentProcessor
from .request import RequestTracker
from .config import ConfigManager

__all__ = [
    "RuntimeEngine",
    "InterpreterManager",
    "ChatStreamer",
    "DocumentProcessor",
    "RequestTracker",
    "ConfigManager",
]

__version__ = "2.0.0"

