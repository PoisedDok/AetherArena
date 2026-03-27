"""
Memory Management Endpoints

@.architecture
Incoming: api/v1/router.py, HTTP clients --- {http_request, json}
Processing: validate memory payloads, orchestrate MemoryService, handle vector search --- {JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_VECTOR_SEARCH}
Outgoing: application/chat/memory_service.py, FastAPI responses --- {Dict[str, Any], json}
"""

from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from uuid import UUID

from core.exceptions import DomainException
from api.dependencies import (
    setup_request_context,
    get_supabase_uow,
)
from api.v1.schemas.memory import (
    MemoryCreate,
    MemoryUpdate,
    MemoryResponse,
    MemoryRelationCreate,
    MemoryRelationResponse,
    MemoryPromoteRequest,
    MemoryDemoteRequest,
    MemoryPromotionResponse
)
from application.chat.memory_service import MemoryService
from data.database.uow import SupabaseUnitOfWork
from config.settings import Settings, get_settings as get_settings_func
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(
    tags=["memories"],
    prefix="/memory",
)


# =============================================================================
# Dependencies
# =============================================================================

async def get_memory_service(
    uow: SupabaseUnitOfWork = Depends(get_supabase_uow),
    settings: Settings = Depends(get_settings_func)
) -> MemoryService:
    """Dependency to get MemoryService instance."""
    return MemoryService(uow, settings)


# =============================================================================
# Memory CRUD Endpoints
# =============================================================================

@router.post("/create", response_model=MemoryResponse, status_code=status.HTTP_201_CREATED, summary="Create memory", openapi_extra={"is_agent_tool": True})
async def create_memory(
    request: MemoryCreate,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryResponse:
    """Create a new memory with automatic embedding generation."""
    try:
        memory = await memory_service.create_memory(
            content=request.content,
            memory_type=request.memory_type,
            importance_score=request.importance_score,
            source_chat_id=request.source_chat_id,
            source_message_id=request.source_message_id,
            metadata=request.metadata,
            created_by=request.created_by
        )
        return MemoryResponse(**memory)
    except Exception as e:
        logger.error("Failed to create memory: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create memory. Check server logs for details."
        )


@router.get("/list", response_model=List[MemoryResponse], summary="List memories", openapi_extra={"is_agent_tool": True})
async def list_memories(
    memory_type: Optional[str] = Query(None, description="Filter by memory type"),
    min_importance: Optional[float] = Query(None, description="Minimum importance score"),
    source_chat_id: Optional[str] = Query(None, description="Filter by source: None=global only, UUID=specific chat, 'all'=both"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> List[MemoryResponse]:
    """
    List memories with optional filters.
    
    source_chat_id parameter (tri-state):
    - None (default): Returns only global memories (source_chat_id IS NULL)
    - UUID string: Returns memories from specific chat
    - 'all': Returns both global and chat-specific memories
    """
    try:
        # Parse source_chat_id: convert UUID string to UUID object, keep None and 'all' as-is
        parsed_chat_id = None
        if source_chat_id is not None and source_chat_id != 'all':
            try:
                parsed_chat_id = UUID(source_chat_id)
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid source_chat_id: must be a valid UUID or 'all'"
                )
        elif source_chat_id == 'all':
            parsed_chat_id = 'all'
        
        memories = await memory_service.list_memories(
            memory_type=memory_type,
            min_importance=min_importance,
            source_chat_id=parsed_chat_id,
            limit=limit,
            offset=offset
        )
        return [MemoryResponse(**m) for m in memories]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list memories: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list memories. Check server logs for details."
        )


@router.get("/get/{memory_id}", response_model=MemoryResponse, summary="Get memory by ID", openapi_extra={"is_agent_tool": True})
async def get_memory(
    memory_id: UUID,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryResponse:
    """Get a specific memory by ID."""
    try:
        memory = await memory_service.get_memory(memory_id)
        if not memory:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Memory {memory_id} not found"
            )
        return MemoryResponse(**memory)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get memory. Check server logs for details."
        )


@router.patch("/update/{memory_id}", response_model=MemoryResponse, summary="Update memory", openapi_extra={"is_agent_tool": True})
async def update_memory(
    memory_id: UUID,
    request: MemoryUpdate,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryResponse:
    """Update a memory's content, type, or importance."""
    try:
        memory = await memory_service.update_memory(
            memory_id=memory_id,
            content=request.content,
            memory_type=request.memory_type,
            importance_score=request.importance_score,
            metadata=request.metadata
        )
        if not memory:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Memory {memory_id} not found"
            )
        return MemoryResponse(**memory)
    except ValueError as e:
        logger.warning("Memory not found for update %s: %s", memory_id, e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Memory {memory_id} not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to update memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update memory. Check server logs for details."
        )


@router.delete("/delete/{memory_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete memory", openapi_extra={"is_agent_tool": True})
async def delete_memory(
    memory_id: UUID,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
):
    """Delete a memory."""
    try:
        # Verify existence before delete (service.delete silently succeeds on non-existent)
        existing = await memory_service.get_memory(memory_id)
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Memory {memory_id} not found"
            )
        await memory_service.delete_memory(memory_id)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete memory. Check server logs for details."
        )


# =============================================================================
# Memory Promotion/Demotion Endpoints
# =============================================================================

@router.post("/promote/{memory_id}", response_model=MemoryPromotionResponse, status_code=status.HTTP_200_OK, summary="Promote memory to global", openapi_extra={"is_agent_tool": True})
async def promote_memory(
    memory_id: UUID,
    request: MemoryPromoteRequest = MemoryPromoteRequest(),
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryPromotionResponse:
    """
    Promote a chat-specific memory to global scope.
    Sets source_chat_id to NULL and optionally boosts importance score.
    """
    try:
        memory = await memory_service.promote_to_global(
            memory_id=memory_id,
            boost_importance=request.boost_importance
        )
        return MemoryPromotionResponse(
            memory=MemoryResponse(**memory),
            message=f"Memory {memory_id} promoted to global scope"
        )
    except ValueError as e:
        logger.warning("Validation error promoting memory %s: %s", memory_id, e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Memory not found or invalid operation."
        )
    except Exception as e:
        logger.error("Failed to promote memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to promote memory. Check server logs for details."
        )


@router.post("/demote/{memory_id}", response_model=MemoryPromotionResponse, status_code=status.HTTP_200_OK, summary="Demote memory to chat-specific", openapi_extra={"is_agent_tool": True})
async def demote_memory(
    memory_id: UUID,
    request: MemoryDemoteRequest,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryPromotionResponse:
    """
    Demote a global memory to chat-specific scope.
    Sets source_chat_id to the specified chat ID.
    """
    try:
        memory = await memory_service.demote_to_chat(
            memory_id=memory_id,
            chat_id=request.chat_id
        )
        return MemoryPromotionResponse(
            memory=MemoryResponse(**memory),
            message=f"Memory {memory_id} demoted to chat {request.chat_id}"
        )
    except ValueError as e:
        logger.warning("Validation error demoting memory %s: %s", memory_id, e)
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Memory not found or invalid operation."
        )
    except Exception as e:
        logger.error("Failed to demote memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to demote memory. Check server logs for details."
        )


# =============================================================================
# Memory Relations Endpoints
# =============================================================================

@router.get("/relation/list/{memory_id}", response_model=List[MemoryRelationResponse], summary="Get memory relations", openapi_extra={"is_agent_tool": True})
async def get_memory_relations(
    memory_id: UUID,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> List[MemoryRelationResponse]:
    """Get all relations for a memory."""
    try:
        relations = await memory_service.get_memory_relations(memory_id)
        return [MemoryRelationResponse(**r) for r in relations]
    except Exception as e:
        logger.error("Failed to get relations for memory %s: %s", memory_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get memory relations. Check server logs for details."
        )


@router.post("/relation/create/{memory_id}", response_model=MemoryRelationResponse, status_code=status.HTTP_201_CREATED, summary="Create memory relation", openapi_extra={"is_agent_tool": True})
async def create_memory_relation(
    memory_id: UUID,
    request: MemoryRelationCreate,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
) -> MemoryRelationResponse:
    """Create a relation between two memories."""
    try:
        relation = await memory_service.create_memory_relation(
            memory_id=memory_id,
            related_memory_id=request.related_memory_id,
            relation_type=request.relation_type,
            strength=request.strength
        )
        return MemoryRelationResponse(**relation)
    except Exception as e:
        logger.error("Failed to create memory relation: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create memory relation. Check server logs for details."
        )


@router.delete("/relation/delete/{relation_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete memory relation", openapi_extra={"is_agent_tool": True})
async def delete_memory_relation(
    relation_id: UUID,
    memory_service: MemoryService = Depends(get_memory_service),
    _context: dict = Depends(setup_request_context)
):
    """Delete a memory relation."""
    try:
        await memory_service.delete_memory_relation(relation_id)
    except Exception as e:
        logger.error("Failed to delete memory relation %s: %s", relation_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete memory relation. Check server logs for details."
        )

