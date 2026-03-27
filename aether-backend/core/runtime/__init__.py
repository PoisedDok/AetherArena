"""Incoming: architecture/module_structure_standard.yaml --- {Runtime modules, Dict[str, Any]}
Processing: expose runtime package interfaces --- {1 jobs: JOB_ROUTE}
Outgoing: backend consumers --- {RuntimeEngine exports, Module references}
"""

from .engine import RuntimeEngine
from .coordinator import RuntimeCoordinator
from .interpreter import InterpreterManager
from .interpreter_adapter import RuntimeInterpreterAdapter
from .session import RuntimeSessionManager
from .media import RuntimeMediaService
from .streaming import ChatStreamer
from .document import DocumentProcessor
from .request import RequestTracker
from .config import ConfigManager

__all__ = [
    "RuntimeEngine",
    "RuntimeCoordinator",
    "RuntimeInterpreterAdapter",
    "RuntimeSessionManager",
    "RuntimeMediaService",
    "InterpreterManager",
    "ChatStreamer",
    "DocumentProcessor",
    "RequestTracker",
    "ConfigManager",
]

__version__ = "2.0.0"

