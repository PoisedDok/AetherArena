"""
Memory Injector - Inject global memories into chat context

Fetches global memories and formats them for injection into the agent's system message.
This ensures every chat session has access to persistent, cross-chat knowledge.

@.architecture
Incoming: core/runtime/interpreter.py, ws/presentation/control_handlers.py --- {chat_id, memory_filters}
Processing: fetch_global_memories(), format_memory_context() --- {2 jobs: JOB_RETRIEVE_DATA, JOB_FORMAT_OUTPUT}
Outgoing: core/runtime/interpreter.py --- {str (formatted memory context)}
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


class MemoryInjector:
    """
    Fetches and formats global memories for injection into chat context.
    """
    
    def __init__(self, memory_service: Optional[Any] = None):
        """
        Initialize memory injector.
        
        Args:
            memory_service: MemoryService instance for fetching memories
        """
        self._memory_service = memory_service
        self._logger = logger
    
    async def _ensure_memory_service(self) -> Optional[Any]:
        """Lazily initialize memory service if not provided."""
        if self._memory_service:
            return self._memory_service

        # Fail-safe: memory injection is optional enrichment. The owning layer (ws/factory or app startup)
        # must explicitly provide a MemoryService via set_memory_service() to avoid runtime reaching into
        # API dependency wiring.
        self._logger.warning(
            "MemoryService not configured for MemoryInjector. "
            "Call core.runtime.memory_injector.set_memory_service(...) during startup."
        )
        return None
    
    async def get_global_memory_context(
        self,
        limit: Optional[int] = None,
        importance_threshold: Optional[float] = None
    ) -> str:
        """
        Fetch global memories and format them for injection into system message.
        
        Args:
            limit: Maximum number of memories to inject, defaults to config
            importance_threshold: Minimum importance score (0.0 to 1.0), defaults to config
        
        Returns:
            Formatted memory context string for system message
        """
        memory_service = await self._ensure_memory_service()
        if not memory_service:
            self._logger.debug("No memory service available for global memory injection")
            return ""
        
        # Get settings for defaults - no fallback
        from config.settings import get_settings
        settings = get_settings()
        limit = limit if limit is not None else settings.memory_service.global_injection_limit
        importance_threshold = importance_threshold if importance_threshold is not None else settings.memory_service.global_injection_min_importance
        
        try:
            # BUG FIX: Use min_importance filter to avoid double-filtering
            # list_memories already sorts by importance, no need to sort again
            memories = await memory_service.list_memories(
                memory_type=None,  # All types
                limit=limit,
                offset=0,
                min_importance=importance_threshold  # Filter in database/service layer
            )
            
            if not memories:
                self._logger.debug("No memories found with importance >= %s", importance_threshold)
                return ""
            
            # Memories are already sorted by importance from list_memories
            # Just apply access frequency boost if needed (using config weights)
            from config.settings import get_settings
            settings = get_settings()
            imp_weight = settings.memory_service.importance_weight
            freq_weight = settings.memory_service.access_frequency_weight
            freq_denom = settings.memory_service.access_count_denominator
            
            if any(m.get('access_count', 0) > 0 for m in memories):
                memories.sort(
                    key=lambda m: (
                        m.get('importance_score', 0.0) * imp_weight + 
                        min(m.get('access_count', 0) / freq_denom, freq_weight)
                    ),
                    reverse=True
                )
            
            # Take top memories (already limited by list_memories, but ensure)
            top_memories = memories[:limit]
            
            if not top_memories:
                self._logger.debug("No memories passed importance threshold")
                return ""
            
            # Format for injection
            formatted = self._format_memory_context(top_memories)
            
            avg_importance = sum(m.get('importance_score', 0) for m in top_memories) / len(top_memories)
            self._logger.info(
                "Injected %d global memories (avg importance: %.2f)",
                len(top_memories), avg_importance,
            )
            
            return formatted
            
        except Exception as e:  # noqa: BLE001 -- memory fetch boundary: return empty on any failure, don't crash chat
            self._logger.error("Failed to fetch global memories: %s", e, exc_info=True)
            return ""
    
    async def get_chat_memory_context(
        self,
        chat_id: UUID,
        limit: Optional[int] = None,
        importance_threshold: Optional[float] = None
    ) -> str:
        """
        Fetch chat-specific memories and format them for injection into system message.
        
        Args:
            chat_id: UUID of the chat to fetch memories for
            limit: Maximum number of memories to inject, defaults to config
            importance_threshold: Minimum importance score (0.0 to 1.0), defaults to config
        
        Returns:
            Formatted memory context string for system message
        """
        memory_service = await self._ensure_memory_service()
        if not memory_service:
            self._logger.debug("No memory service available for chat memory injection")
            return ""
        
        # Get settings for defaults
        from config.settings import get_settings
        settings = get_settings()
        limit = limit if limit is not None else settings.memory_service.global_injection_limit
        importance_threshold = importance_threshold if importance_threshold is not None else settings.memory_service.chat_injection_min_importance
        
        try:
            # Fetch chat-specific memories using tri-state source_chat_id filter
            memories = await memory_service.list_memories(
                source_chat_id=chat_id,  # THIS chat only
                memory_type=None,
                limit=limit,
                min_importance=importance_threshold
            )
            
            if not memories:
                self._logger.debug("No chat-specific memories found for chat %s", chat_id)
                return ""
            
            # Apply access frequency boost if needed (same logic as global)
            settings = get_settings()
            imp_weight = settings.memory_service.importance_weight
            freq_weight = settings.memory_service.access_frequency_weight
            freq_denom = settings.memory_service.access_count_denominator
            
            if any(m.get('access_count', 0) > 0 for m in memories):
                memories.sort(
                    key=lambda m: (
                        m.get('importance_score', 0.0) * imp_weight + 
                        min(m.get('access_count', 0) / freq_denom, freq_weight)
                    ),
                    reverse=True
                )
            
            # Take top memories
            top_memories = memories[:limit]
            
            if not top_memories:
                self._logger.debug("No chat-specific memories passed importance threshold for chat %s", chat_id)
                return ""
            
            # Format for injection with chat-specific header
            formatted = self._format_chat_memory_context(top_memories)
            
            avg_importance = sum(m.get('importance_score', 0) for m in top_memories) / len(top_memories)
            self._logger.info(
                "Injected %d chat-specific memories for chat %s (avg importance: %.2f)",
                len(top_memories), chat_id, avg_importance,
            )
            
            return formatted
            
        except Exception as e:  # noqa: BLE001 -- memory fetch boundary: return empty on any failure, don't crash chat
            self._logger.error("Failed to fetch chat-specific memories for %s: %s", chat_id, e, exc_info=True)
            return ""
    
    def _format_memory_context(self, memories: List[Dict[str, Any]]) -> str:
        """
        Format memories into a structured string for system message injection.
        
        Args:
            memories: List of memory dictionaries
        
        Returns:
            Formatted memory context string
        """
        if not memories:
            return ""
        
        # Get truncation length from config - no fallback
        from config.settings import get_settings
        settings = get_settings()
        truncation_length = settings.memory_service.content_truncation_length
        
        lines = [
            "\n\n## 🧠 Global Memory Context",
            "You have access to the following persistent knowledge from previous conversations:\n"
        ]
        
        # Group by type
        by_type: Dict[str, List[Dict[str, Any]]] = {}
        for mem in memories:
            mem_type = mem.get('memory_type', 'general')
            if mem_type not in by_type:
                by_type[mem_type] = []
            by_type[mem_type].append(mem)
        
        # Format each type
        for mem_type, mem_list in sorted(by_type.items()):
            type_label = mem_type.replace('_', ' ').title()
            lines.append(f"\n### {type_label}s:")
            
            for mem in mem_list:
                content = mem.get('content', '')
                importance = mem.get('importance_score', 0.0)
                
                # Truncate long memories (using config value)
                if len(content) > truncation_length:
                    content = content[:truncation_length - 3] + "..."
                
                # Format with importance indicator
                indicator = "⭐" * min(3, int(importance * 3) + 1)
                lines.append(f"- {indicator} {content}")
        
        lines.append("\nUse this knowledge to provide context-aware responses.\n")
        
        return "\n".join(lines)
    
    def _format_chat_memory_context(self, memories: List[Dict[str, Any]]) -> str:
        """
        Format chat-specific memories into a structured string for system message injection.
        
        Args:
            memories: List of memory dictionaries
        
        Returns:
            Formatted memory context string with chat-specific header
        """
        if not memories:
            return ""
        
        # Get truncation length from config
        from config.settings import get_settings
        settings = get_settings()
        truncation_length = settings.memory_service.content_truncation_length
        
        lines = [
            "\n\n## 💬 Chat Memory Context",
            "You have access to the following knowledge from this conversation:\n"
        ]
        
        # Group by type (same logic as global)
        by_type: Dict[str, List[Dict[str, Any]]] = {}
        for mem in memories:
            mem_type = mem.get('memory_type', 'general')
            if mem_type not in by_type:
                by_type[mem_type] = []
            by_type[mem_type].append(mem)
        
        # Format each type
        for mem_type, mem_list in sorted(by_type.items()):
            type_label = mem_type.replace('_', ' ').title()
            lines.append(f"\n### {type_label}s:")
            
            for mem in mem_list:
                content = mem.get('content', '')
                importance = mem.get('importance_score', 0.0)
                
                # Truncate long memories
                if len(content) > truncation_length:
                    content = content[:truncation_length - 3] + "..."
                
                # Format with importance indicator
                indicator = "⭐" * min(3, int(importance * 3) + 1)
                lines.append(f"- {indicator} {content}")
        
        lines.append("\nUse this conversation-specific knowledge to provide more contextual responses.\n")
        
        return "\n".join(lines)


# Singleton instance
_memory_injector: Optional[MemoryInjector] = None


def get_memory_injector() -> MemoryInjector:
    """Get or create the global MemoryInjector instance."""
    global _memory_injector
    if _memory_injector is None:
        _memory_injector = MemoryInjector()
    return _memory_injector


def set_memory_service(memory_service: Any) -> None:
    """Set the memory service for the global MemoryInjector instance."""
    injector = get_memory_injector()
    injector._memory_service = memory_service
    logger.info("Memory service configured for global memory injection")

