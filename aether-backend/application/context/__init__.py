"""
Context Management Application Layer

Application services for conversation context management.

@.architecture
Incoming: api/v1/endpoints/context.py --- {chat_id, UUID}
Processing: orchestrate context operations, delegate to runtime --- {JOB_ORCHESTRATE}
Outgoing: core/runtime/interpreter.py, data/database/repositories/chat.py --- {Dict[str, Any], json}
"""

from .context_manager import ContextManager

__all__ = ["ContextManager"]

