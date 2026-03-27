"""
Incoming: none (pure state management)
Processing: message buffering, text truncation --- {1 job: JOB_TRANSFORM_DATA}
Outgoing: domain → application

Message Accumulator - Domain service for message accumulation

Pure business logic, NO I/O.
Accumulates user and agent messages for trail creation.
"""

from typing import List


class MessageAccumulator:
    """
    Domain service for accumulating messages during stream processing.
    
    Buffers:
    - User message (first 500 chars)
    - Agent message parts (accumulated, first 500 chars on retrieval)
    
    Pure state management, NO I/O.
    """
    
    def __init__(self, user_message: str, max_length: int = 500):
        """
        Initialize message accumulator.
        
        Args:
            user_message: Initial user message
            max_length: Maximum message length (default 500)
        """
        self._user_message = user_message[:max_length]
        self._agent_message_parts: List[str] = []
        self._max_length = max_length
    
    def add_agent_content(self, content: str) -> None:
        """
        Add agent message content.
        
        Args:
            content: Content chunk to append
        """
        self._agent_message_parts.append(content)
    
    def get_user_message(self) -> str:
        """
        Get user message (truncated to max_length).
        
        Returns:
            User message string
        """
        return self._user_message
    
    def get_agent_message(self) -> str:
        """
        Get accumulated agent message (truncated to max_length).
        
        Returns:
            Agent message string, or fallback if empty
        """
        if not self._agent_message_parts:
            return "[Agent response with artifacts]"
        
        accumulated = "".join(self._agent_message_parts)
        return accumulated[:self._max_length]

