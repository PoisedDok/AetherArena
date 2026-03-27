"""
Chat Context Integration

Provides agent tools for cross-chat context management.

@.architecture
Incoming: IntegrationLoader, Open Interpreter --- {computer.chats.*, tool_call}
Processing: expose 6 chat context tools --- {1 job: JOB_ROUTE}
Outgoing: tools.py, Open Interpreter --- {function_exports}
"""

from .tools import (
    chats_search,
    chats_attach,
    chats_summarize,
    chats_list_references,
    chats_unlink,
    chats_list
)

__all__ = [
    "chats_search",
    "chats_attach",
    "chats_summarize",
    "chats_list_references",
    "chats_unlink",
    "chats_list"
]

