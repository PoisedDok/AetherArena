"""
Memory Service

Manages chat memories with vector search and LLM-powered extraction.

@.architecture
Incoming: API endpoints, Agent tools --- {UUID, query text, memory content}
Processing: vector search, memory CRUD, LLM extraction --- {5 jobs: JOB_HTTP_REQUEST, JOB_MANAGE_STORAGE, JOB_ORCHESTRATE, JOB_QUERY_DB, JOB_TRANSFORM_DATA}
Outgoing: Database (memories table), Embedding service --- {memories, embeddings}
"""

from typing import List, Dict, Any, Optional
from uuid import UUID
import httpx
import json

from data.database.uow import SupabaseUnitOfWork
from data.database.repositories.chat import ChatRepository
from config.settings import Settings
from monitoring import get_logger

logger = get_logger(__name__)

class MemoryService:
    """
    Service for managing memories with vector search.
    
    Features:
    - LLM-powered memory extraction from chat summaries
    - Vector similarity search (pgvector)
    - Hybrid search (vector + keyword)
    - Memory relations and tags
    - Automatic embedding generation
    """
    
    def __init__(self, uow: SupabaseUnitOfWork, settings: Settings):
        self._uow = uow
        self._gateway = uow.gateway
        self._chat_repository = ChatRepository(self._gateway)
        self._settings = settings
        base_url = settings.base_url.rstrip("/")
        self._llm_url = f"{base_url}/v1/llm"
        self._embedding_url = settings.embedding_service.service_url
        self._http_timeout = settings.http_client.embedding_timeout
    
    async def extract_memories_from_groups(
        self,
        chat_id: UUID,
        num_groups: Optional[int] = None,
        max_sequence: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Extract memories from recent chat groups (raw messages) using LLM.
        """
        try:
            # Use config default if not specified (NO HARDCODING)
            if num_groups is None:
                num_groups = self._settings.memory_service.group_frequency
            
            seq_msg = f" (up to sequence {max_sequence})" if max_sequence else ""
            logger.info("Extracting memories from %d recent groups in chat %s%s", num_groups, chat_id, seq_msg)
            
            # Get recent groups directly using gateway to support sequence bounding
            filters = {"chat_id": str(chat_id)}
            if max_sequence is not None:
                filters["sequence_number"] = f"lte.{max_sequence}"
                
            groups_result = await self._gateway.select(
                "groups",
                filters=filters,
                limit=num_groups,
                order_by="sequence_number.desc"
            )
            
            if not groups_result or len(groups_result) == 0:
                logger.warning("No groups found for chat %s", chat_id)
                return []
            
            # Format groups as conversation for LLM
            conversation_text = self._format_groups_for_llm(groups_result)
            
            # Call LLM for memory extraction from raw conversation
            memories_data = await self._call_llm_for_memory_extraction(conversation_text)
            
            # Create memories with embeddings
            created_memories = []
            for memory_data in memories_data:
                memory = await self.create_memory(
                    content=memory_data['content'],
                    memory_type=memory_data.get('type', 'insight'),
                    importance_score=memory_data.get('importance', 0.5),
                    source_chat_id=chat_id,
                    metadata={
                        'tags': memory_data.get('tags', []),
                        'extracted_from_groups': num_groups
                    },
                    created_by='memory_agent'
                )
                created_memories.append(memory)
            
            logger.info("Extracted %d memories from %d groups in chat %s", len(created_memories), num_groups, chat_id)
            return created_memories
        except Exception as e:
            logger.error("Failed to extract memories for chat %s: %s", chat_id, e, exc_info=True)
            raise
    
    
    async def create_memory(
        self,
        content: str,
        memory_type: str,
        importance_score: Optional[float] = None,
        source_chat_id: Optional[UUID] = None,
        source_message_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        created_by: str = 'user',
        expires_at: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create a new memory with automatic embedding generation.
        """
        try:
            # Resolve importance score from settings if not provided
            if importance_score is None:
                if created_by == 'user':
                    importance_score = self._settings.memory_service.default_manual_importance
                else:
                    importance_score = self._settings.memory_service.default_auto_importance
            
            # Generate embedding
            embedding = await self._generate_embedding(content)
            
            # Deduplication check
            match_threshold = 0.92  # High threshold for near-identical semantic match
            similar = await self._gateway.rpc(
                'search_memories',
                {
                    'query_embedding': embedding,
                    'match_threshold': match_threshold,
                    'match_count': 5
                }
            )
            
            if similar:
                target_chat_str = str(source_chat_id) if source_chat_id else None
                duplicate = next(
                    (m for m in similar 
                     if m.get('memory_type') == memory_type and 
                        (str(m.get('source_chat_id')) if m.get('source_chat_id') else None) == target_chat_str),
                    None
                )
                
                if duplicate:
                    logger.info("Found near-identical memory %s. Merging to prevent bloat.", duplicate['id'])
                    current_importance = duplicate.get("importance_score", 0.5)
                    new_importance = min(1.0, current_importance + 0.05)
                    updated = await self._gateway.update(
                        "memories",
                        {"importance_score": new_importance},
                        record_id=str(duplicate["id"]),
                        admin=True
                    )
                    return updated[0] if isinstance(updated, list) and updated else duplicate
            
            # Insert memory
            data = {
                "content": content,
                "memory_type": memory_type,
                "importance_score": max(0.0, min(1.0, importance_score)),
                "source_chat_id": str(source_chat_id) if source_chat_id else None,
                "source_message_id": str(source_message_id) if source_message_id else None,
                "embedding": embedding,
                "metadata": metadata or {},
                "created_by": created_by,
                "expires_at": expires_at
            }
            
            result = await self._gateway.insert(
                table="memories",
                data=[data],
                admin=True
            )
            
            memory = result[0] if result else data
            logger.info("Created memory: %s...", content[:50])
            return memory
        except Exception as e:
            logger.error("Failed to create memory: %s", e, exc_info=True)
            raise
    
    async def search_memories(
        self,
        query: str,
        match_threshold: Optional[float] = None,
        match_count: Optional[int] = None,
        memory_types: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        Search memories using vector similarity.
        """
        try:
            # Use config defaults if not specified
            match_threshold = match_threshold if match_threshold is not None else self._settings.memory_service.vector_match_threshold
            match_count = match_count if match_count is not None else self._settings.memory_service.default_search_limit
            
            # Generate query embedding
            query_embedding = await self._generate_embedding(query)
            
            # Call pgvector search function
            result = await self._gateway.rpc(
                'search_memories',
                {
                    'query_embedding': query_embedding,
                    'match_threshold': match_threshold,
                    'match_count': match_count
                }
            )
            
            memories = result if result else []
            
            # Filter by memory type if specified
            if memory_types:
                memories = [m for m in memories if m.get('memory_type') in memory_types]
            
            logger.info("Found %d memories for query: '%s...'", len(memories), query[:50])
            return memories
        except Exception as e:
            logger.error("Failed to search memories: %s", e, exc_info=True)
            raise
    
    async def search_memories_hybrid(
        self,
        query_text: str,
        semantic_weight: Optional[float] = None,
        keyword_weight: Optional[float] = None,
        match_threshold: Optional[float] = None,
        match_count: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Search memories using hybrid approach (vector + keyword).
        """
        try:
            # Use config defaults if not specified
            semantic_weight = semantic_weight if semantic_weight is not None else self._settings.memory_service.semantic_weight
            keyword_weight = keyword_weight if keyword_weight is not None else self._settings.memory_service.keyword_weight
            match_threshold = match_threshold if match_threshold is not None else self._settings.memory_service.vector_match_threshold
            match_count = match_count if match_count is not None else self._settings.memory_service.default_search_limit
            
            # Generate query embedding
            query_embedding = await self._generate_embedding(query_text)
            
            # Call hybrid search function
            result = await self._gateway.rpc(
                'search_memories_hybrid',
                {
                    'query_text': query_text,
                    'query_embedding': query_embedding,
                    'semantic_weight': semantic_weight,
                    'keyword_weight': keyword_weight,
                    'match_threshold': match_threshold,
                    'match_count': match_count
                }
            )
            
            memories = result if result else []
            logger.info("Hybrid search found %d memories", len(memories))
            return memories
        except Exception as e:
            logger.error("Failed to search memories hybrid: %s", e, exc_info=True)
            raise
    
    async def update_memory(
        self,
        memory_id: UUID,
        content: Optional[str] = None,
        memory_type: Optional[str] = None,
        importance_score: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Update a memory. Re-generates embedding if content changed."""
        try:
            # Get existing memory
            existing = await self._gateway.select(
                "memories",
                filters={"id": str(memory_id)}
            )
            
            if not existing or len(existing) == 0:
                raise ValueError(f"Memory {memory_id} not found")
            
            # Build update data
            update_data = {}
            if content is not None:
                update_data["content"] = content
                # Re-generate embedding
                update_data["embedding"] = await self._generate_embedding(content)
            if memory_type is not None:
                update_data["memory_type"] = memory_type
            if importance_score is not None:
                update_data["importance_score"] = max(0.0, min(1.0, importance_score))
            if metadata is not None:
                update_data["metadata"] = metadata
            
            # Update
            result = await self._gateway.update(
                table="memories",
                data=update_data,
                record_id=str(memory_id),
                admin=True
            )
            
            if isinstance(result, list) and result:
                result = result[0]
                
            return result
        except Exception as e:
            logger.error("Failed to update memory %s: %s", memory_id, e, exc_info=True)
            raise
    
    async def delete_memory(self, memory_id: UUID) -> bool:
        """Delete a memory."""
        try:
            await self._gateway.delete(
                table="memories",
                record_id=str(memory_id),
                admin=True
            )
            return True
        except Exception as e:
            logger.error("Failed to delete memory %s: %s", memory_id, e, exc_info=True)
            raise
    
    async def list_memories(
        self,
        limit: Optional[int] = None,
        offset: int = 0,
        memory_type: Optional[str] = None,
        min_importance: Optional[float] = None,
        source_chat_id: Optional[UUID | str] = None
    ) -> List[Dict[str, Any]]:
        """
        List memories with optional filters, sorted by importance (descending).
        """
        try:
            # Use config defaults if not specified
            limit = limit if limit is not None else self._settings.memory_service.default_list_limit
            
            filters = {}
            if memory_type:
                filters["memory_type"] = memory_type
            
            # Tri-state source_chat_id filter
            if source_chat_id is None:
                # Default: only global memories (source_chat_id IS NULL)
                filters["source_chat_id"] = "is.null"
            elif source_chat_id != 'all':
                # Specific chat: source_chat_id = chat_id (no eq. prefix, gateway adds it)
                filters["source_chat_id"] = str(source_chat_id)
            # If source_chat_id == 'all', don't add filter (fetch both global and chat-specific)
            
            if min_importance is not None:
                filters["importance_score"] = {"gte": min_importance}
            
            result = await self._gateway.select(
                "memories",
                filters=filters,
                limit=limit,
                offset=offset,
                order_by="importance_score.desc,extracted_at.desc"  # Sort by importance, then newest
            )
            
            memories = result if result else []
            
            return memories
        except Exception as e:
            logger.error("Failed to list memories: %s", e, exc_info=True)
            raise
    
    async def _generate_embedding(self, text: str) -> List[float]:
        """Generate embedding using Perplexica's local ONNX embedding service (OpenAI-compatible)."""
        try:
            async with httpx.AsyncClient(timeout=self._http_timeout) as client:
                response = await client.post(
                    self._embedding_url,
                    json={
                        "input": text,
                        "model": self._settings.embedding_service.model,
                    }
                )
                response.raise_for_status()
                data = response.json()
                return data['data'][0]['embedding']
        except Exception as e:
            logger.error("Error generating embedding: %s", e, exc_info=True)
            raise
    
    def _format_groups_for_llm(self, groups: List[Dict[str, Any]]) -> str:
        """
        Format groups into conversation text for LLM processing.
        """
        conversation_lines = []
        # Groups are returned DESC (newest first), reverse for chronological order
        for group in reversed(groups):
            seq = group.get('sequence_number', '?')
            user_msg = group.get('user_message', '')
            agent_msg = group.get('agent_message', '')
            
            conversation_lines.append(f"[Turn {seq}]")
            conversation_lines.append(f"User: {user_msg}")
            conversation_lines.append(f"Assistant: {agent_msg}")
            conversation_lines.append("")  # Blank line between turns
        
        return "\n".join(conversation_lines)
    
    async def _call_llm_for_memory_extraction(self, conversation_text: str) -> List[Dict[str, Any]]:
        """
        Call LLM to extract memories from raw conversation text.
        """
        # Fetch agent config to override prompt and model if available
        agent_configs = await self._gateway.select(
            "agent_configs",
            filters={"agent_name": "memory"},
            limit=1
        )
        
        model_name = self._settings.llm.summarizer_model
        system_prompt = ""
        messages = []
        
        if agent_configs and len(agent_configs) > 0:
            config = agent_configs[0]
            if config.get("model_name"):
                model_name = config.get("model_name")
            if config.get("prompt_template"):
                try:
                    system_prompt = config["prompt_template"].format(messages=conversation_text)
                    messages = [
                        {"role": "system", "content": system_prompt}
                    ]
                except Exception as e:
                    logger.warning("Failed to format agent prompt template: %s", e)
                    system_prompt = ""
        
        if not system_prompt:
            # Fallback to hardcoded prompt
            memory_types_str = "/".join(self._settings.memory_service.valid_memory_types)
            system_prompt = f"""Extract important memories from this conversation. 
Return JSON with 'memories' array. Each memory should have:
- content: The memory content (string)
- type: Memory type ({memory_types_str})
- importance: Importance score 0.0-1.0 (float)
- tags: Array of relevant tags (strings)

Focus on conversational knowledge:
- User facts, details, and context
- Preferences and constraints
- Decisions made and rationale
- Insights, summaries, and action items
- Project/task specific information

Return format: {{"memories": [{{...}}, {{...}}]}}"""
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": conversation_text}
            ]
        
        try:
            async with httpx.AsyncClient(timeout=self._settings.http_client.llm_timeout) as client:
                response = await client.post(
                    f"{self._llm_url}/chat/completions",
                    json={
                        "model": model_name,
                        "messages": messages,
                        "temperature": self._settings.memory_service.extraction_temperature,
                        "max_tokens": self._settings.memory_service.extraction_max_tokens
                    }
                )
                response.raise_for_status()
                
                completion = response.json()
                content = completion["choices"][0]["message"]["content"]
                
                # Strip markdown code blocks if present
                if content.startswith("```"):
                    lines = content.split("\n")
                    if lines[0].startswith("```"):
                        lines = lines[1:]
                    if lines and lines[-1].startswith("```"):
                        lines = lines[:-1]
                    content = "\n".join(lines)
                
                # Try to parse JSON
                try:
                    data = json.loads(content)
                    if isinstance(data, dict):
                        return data.get('memories', [])
                    elif isinstance(data, list):
                        return data
                    else:
                        logger.warning("LLM returned unexpected JSON structure")
                        return []
                except json.JSONDecodeError:
                    # Fallback: treat as single memory
                    logger.warning("LLM returned non-JSON, creating single memory")
                    return [{
                        "content": content[:500],
                        "type": "insight",
                        "importance": 0.5,
                        "tags": []
                    }]
        except Exception as e:
            logger.error("Error calling LLM for memory extraction: %s", e, exc_info=True)
            raise
    
    
    async def get_memory(self, memory_id: UUID) -> Optional[Dict[str, Any]]:
        """Get a memory by ID."""
        try:
            result = await self._gateway.select(
                "memories",
                filters={"id": str(memory_id)}
            )
            return result[0] if result else None
        except Exception as e:
            logger.error("Failed to get memory %s: %s", memory_id, e, exc_info=True)
            raise
    
    async def promote_to_global(
        self,
        memory_id: UUID,
        boost_importance: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Promote chat-specific memory to global.
        Sets source_chat_id = NULL and optionally boosts importance.
        """
        try:
            # Resolve boost from settings if not provided
            if boost_importance is None:
                boost_importance = self._settings.memory_service.promotion_boost
                
            # Get existing memory to verify it exists and is chat-specific
            memory = await self.get_memory(memory_id)
            if not memory:
                raise ValueError(f"Memory {memory_id} not found")
            
            if memory.get('source_chat_id') is None:
                logger.warning("Memory %s is already global, skipping promotion", memory_id)
                return memory
            
            # Build update data
            current_importance = memory.get('importance_score', 0.5)
            new_importance = min(1.0, current_importance + boost_importance)
            
            update_data = {
                "source_chat_id": None,
                "importance_score": new_importance
            }
            
            result = await self._gateway.update(
                table="memories",
                data=update_data,
                record_id=str(memory_id),
                admin=True
            )
            
            if isinstance(result, list) and result:
                result = result[0]
            
            logger.info("Promoted memory %s to global (importance: %.2f -> %.2f)", memory_id, current_importance, new_importance)
            return result
        except Exception as e:
            logger.error("Failed to promote memory %s: %s", memory_id, e, exc_info=True)
            raise
    
    async def demote_to_chat(
        self,
        memory_id: UUID,
        chat_id: UUID
    ) -> Dict[str, Any]:
        """
        Demote global memory to chat-specific.
        Sets source_chat_id = chat_id.
        """
        try:
            # Get existing memory to verify it exists
            memory = await self.get_memory(memory_id)
            if not memory:
                raise ValueError(f"Memory {memory_id} not found")
            
            if memory.get('source_chat_id') is not None:
                logger.warning("Memory %s is already chat-specific, updating chat_id", memory_id)
            
            update_data = {"source_chat_id": str(chat_id)}
            
            result = await self._gateway.update(
                table="memories",
                data=update_data,
                record_id=str(memory_id),
                admin=True
            )
            
            if isinstance(result, list) and result:
                result = result[0]
            
            logger.info("Demoted memory %s to chat %s", memory_id, chat_id)
            return result
        except Exception as e:
            logger.error("Failed to demote memory %s to chat %s: %s", memory_id, chat_id, e, exc_info=True)
            raise
    
    async def auto_promote_important_memories(
        self,
        chat_id: UUID,
        importance_threshold: Optional[float] = None
    ) -> List[UUID]:
        """
        Auto-promote high-importance chat memories to global.
        Called by background worker after memory extraction.
        """
        try:
            # Resolve threshold from settings if not provided
            if importance_threshold is None:
                importance_threshold = self._settings.memory_service.promotion_threshold
                
            # Fetch high-importance chat-specific memories
            memories = await self.list_memories(
                source_chat_id=chat_id,
                min_importance=importance_threshold,
                limit=100  # Process up to 100 at a time
            )
            
            if not memories:
                logger.debug("No memories above threshold %s found for chat %s", importance_threshold, chat_id)
                return []
            
            promoted_ids = []
            for memory in memories:
                try:
                    memory_id = memory['id']
                    await self.promote_to_global(memory_id, boost_importance=self._settings.memory_service.promotion_boost)
                    promoted_ids.append(memory_id)
                except Exception as e:
                    logger.error("Failed to promote memory %s: %s", memory.get("id"), e, exc_info=True)
            
            logger.info("Auto-promoted %d/%d memories from chat %s", len(promoted_ids), len(memories), chat_id)
            return promoted_ids
        except Exception as e:
            logger.error("Failed to auto-promote memories for chat %s: %s", chat_id, e, exc_info=True)
            raise
    
    async def get_memory_relations(self, memory_id: UUID) -> List[Dict[str, Any]]:
        """Get all relations for a memory."""
        try:
            result = await self._gateway.select(
                "memory_relations",
                filters={"memory_id": str(memory_id)}
            )
            return result or []
        except Exception as e:
            logger.error("Failed to get memory relations for memory %s: %s", memory_id, e, exc_info=True)
            raise
    
    async def create_memory_relation(
        self,
        memory_id: UUID,
        related_memory_id: UUID,
        relation_type: str,
        strength: float = 0.5
    ) -> Dict[str, Any]:
        """Create a relation between two memories."""
        try:
            data = {
                "memory_id": str(memory_id),
                "related_memory_id": str(related_memory_id),
                "relation_type": relation_type,
                "strength": strength
            }
            result = await self._gateway.insert("memory_relations", [data])
            return result[0] if result else data
        except Exception as e:
            logger.error("Failed to create memory relation between %s and %s: %s", memory_id, related_memory_id, e, exc_info=True)
            raise
    
    async def delete_memory_relation(self, relation_id: UUID) -> bool:
        """Delete a memory relation."""
        try:
            await self._gateway.delete(
                table="memory_relations",
                record_id=str(relation_id),
                admin=True
            )
            return True
        except Exception as e:
            logger.error("Failed to delete memory relation %s: %s", relation_id, e, exc_info=True)
            raise


    
    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
