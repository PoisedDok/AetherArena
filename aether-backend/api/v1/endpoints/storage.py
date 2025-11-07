"""
Storage Endpoints (PostgreSQL)

Production-ready endpoints for persistent chat/message/artifact/trail storage in PostgreSQL.
Uses ChatRepository and StorageRepository for all database operations with proper transaction management.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST/PUT/DELETE) --- {HTTP requests to /v1/api/storage/*, /v1/api/trails/*, ChatCreate, MessageCreate, ArtifactCreate, TrailState JSON payloads}
Processing: list_chats(), create_chat(), get_chat(), update_chat(), delete_chat(), get_messages(), create_message(), get_artifacts(), create_artifact(), update_artifact_message_id(), save_trail_state(), load_trail_state(), delete_trail_state(), save_traceability_data(), load_traceability_data(), get_storage_stats(), health_check() --- {15 jobs: artifact_crud, chat_crud, data_validation, dependency_injection, error_handling, health_checking, http_communication, json_persistence, message_crud, query_execution, serialization, statistics_collection, traceability_persistence, trail_state_persistence, transaction_management}
Outgoing: data/database/repositories/chat.py, data/database/repositories/storage.py, Frontend (HTTP) --- {ChatRepository, StorageRepository method calls, ChatResponse, MessageResponse, ArtifactResponse, TrailStateResponse, TraceabilityResponse schemas}
"""

from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from uuid import UUID

from api.dependencies import setup_request_context, get_database
from api.v1.schemas.chat import (
    ChatCreate,
    ChatUpdate,
    ChatResponse,
    MessageCreate,
    MessageResponse,
    ArtifactCreate,
    ArtifactResponse,
    ArtifactUpdateMessageIdRequest,
    ArtifactUpdateMessageIdResponse
)
from data.database.connection import DatabaseConnection
from data.database.repositories.chat import ChatRepository
from data.database.repositories.storage import StorageRepository
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["storage"], prefix="/api/storage")


# =============================================================================
# Repository Dependencies
# =============================================================================

async def get_chat_repository(
    db: DatabaseConnection = Depends(get_database)
) -> ChatRepository:
    """Get chat repository instance."""
    return ChatRepository(db)


async def get_storage_repository(
    db: DatabaseConnection = Depends(get_database)
) -> StorageRepository:
    """Get storage repository instance."""
    return StorageRepository(db)


# =============================================================================
# Chat Endpoints
# =============================================================================

@router.get("/chats", response_model=List[ChatResponse], summary="List all chats")
async def list_chats(
    skip: int = 0,
    limit: int = 50,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> List[ChatResponse]:
    """
    Validate pagination parameters.
    """
    if skip < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Skip must be non-negative"
        )
    if limit < 1 or limit > 500:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Limit must be between 1 and 500"
        )
    """
    List all chats ordered by most recently updated.
    
    Args:
        skip: Number of chats to skip (offset)
        limit: Maximum number of chats to return
        
    Returns:
        List of chat objects with message counts
    """
    try:
        chats = await repo.list_chats(limit=limit, offset=skip)
        logger.info(f"Retrieved {len(chats)} chats (skip={skip}, limit={limit})")
        
        # Convert to response models
        return [
            ChatResponse(
                id=str(chat.id),
                title=chat.title,
                created_at=chat.created_at,
                updated_at=chat.updated_at,
                message_count=getattr(chat, 'message_count', 0)
            )
            for chat in chats
        ]
        
    except Exception as e:
        logger.error(f"Failed to list chats: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve chats"
        )


@router.post("/chats", response_model=ChatResponse, status_code=status.HTTP_201_CREATED, summary="Create chat")
async def create_chat(
    chat: ChatCreate,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> ChatResponse:
    """
    Create a new chat.
    
    Args:
        chat: Chat creation data
        
    Returns:
        Created chat object
    """
    try:
        new_chat = await repo.create_chat(title=chat.title)
        logger.info(f"Created chat {new_chat.id} with title '{chat.title}'")
        
        return ChatResponse(
            id=str(new_chat.id),
            title=new_chat.title,
            created_at=new_chat.created_at,
            updated_at=new_chat.updated_at,
            message_count=0
        )
        
    except Exception as e:
        logger.error(f"Failed to create chat: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create chat"
        )


@router.get("/chats/{chat_id}", response_model=ChatResponse, summary="Get chat by ID")
async def get_chat(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> ChatResponse:
    """
    Get a specific chat by ID.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Chat object with statistics
        
    Raises:
        404: If chat not found
    """
    try:
        chat = await repo.get_chat(chat_id)
        
        if not chat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        
        # Get message count
        stats = await repo.get_chat_statistics(chat_id)
        
        return ChatResponse(
            id=str(chat.id),
            title=chat.title,
            created_at=chat.created_at,
            updated_at=chat.updated_at,
            message_count=stats.get('message_count', 0)
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve chat"
        )


@router.put("/chats/{chat_id}", response_model=ChatResponse, summary="Update chat")
async def update_chat(
    chat_id: UUID,
    update: ChatUpdate,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> ChatResponse:
    """
    Update chat (currently only title).
    
    Args:
        chat_id: Chat UUID
        update: Chat update data
        
    Returns:
        Updated chat object
        
    Raises:
        404: If chat not found
    """
    try:
        updated_chat = await repo.update_chat(chat_id, title=update.title)
        
        if not updated_chat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        
        logger.info(f"Updated chat {chat_id} title to '{update.title}'")
        
        return ChatResponse(
            id=str(updated_chat.id),
            title=updated_chat.title,
            created_at=updated_chat.created_at,
            updated_at=updated_chat.updated_at,
            message_count=0
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update chat"
        )


@router.delete("/chats/{chat_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete chat")
async def delete_chat(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
):
    """
    Delete chat and all associated messages/artifacts (CASCADE).
    
    Args:
        chat_id: Chat UUID
        
    Raises:
        404: If chat not found
    """
    try:
        deleted = await repo.delete_chat(chat_id)
        
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        
        logger.info(f"Deleted chat {chat_id} and all associated data")
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete chat"
        )


# =============================================================================
# Message Endpoints
# =============================================================================

@router.get("/chats/{chat_id}/messages", response_model=List[MessageResponse], summary="List messages")
async def get_messages(
    chat_id: UUID,
    limit: int = 100,
    offset: int = 0,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> List[MessageResponse]:
    """
    Get messages for a chat ordered by timestamp.
    
    Args:
        chat_id: Chat UUID
        limit: Maximum number of messages
        offset: Number of messages to skip
        
    Returns:
        List of message objects
    """
    # Validate pagination
    if offset < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Offset must be non-negative"
        )
    if limit < 1 or limit > 1000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Limit must be between 1 and 1000"
        )
    
    try:
        messages = await repo.get_messages(chat_id, limit=limit, offset=offset)
        logger.info(f"Retrieved {len(messages)} messages for chat {chat_id}")
        
        return [
            MessageResponse(
                id=msg.id,
                chat_id=msg.chat_id,
                role=msg.role,
                content=msg.content,
                created_at=msg.created_at,
                token_count=msg.tokens_used,
                metadata=None,
                parent_message_id=msg.correlation_id
            )
            for msg in messages
        ]
        
    except Exception as e:
        logger.error(f"Failed to get messages for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve messages"
        )


@router.post("/chats/{chat_id}/messages", response_model=MessageResponse, status_code=status.HTTP_201_CREATED, summary="Create message")
async def create_message(
    chat_id: UUID,
    message: MessageCreate,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> MessageResponse:
    """
    Create a new message in a chat.
    
    Args:
        chat_id: Chat UUID
        message: Message creation data
        
    Returns:
        Created message object
        
    Raises:
        404: If chat not found
    """
    try:
        new_message = await repo.create_message(
            chat_id=chat_id,
            role=message.role,
            content=message.content,
            llm_model=message.llm_model,
            llm_provider=message.llm_provider,
            tokens_used=message.tokens_used
        )
        
        logger.info(f"Created {message.role} message {new_message.id} in chat {chat_id}")
        
        return MessageResponse(
            id=new_message.id,
            chat_id=new_message.chat_id,
            role=new_message.role,
            content=new_message.content,
            created_at=new_message.created_at,
            token_count=new_message.tokens_used,
            metadata=None,
            parent_message_id=None
        )
        
    except ValueError as e:
        # Chat not found
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found"
        )
    except Exception as e:
        logger.error(f"Failed to create message in chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create message"
        )


# =============================================================================
# Artifact Endpoints
# =============================================================================

@router.get("/chats/{chat_id}/artifacts", response_model=List[ArtifactResponse], summary="List artifacts")
async def get_artifacts(
    chat_id: UUID,
    artifact_type: str = None,
    limit: int = 100,
    offset: int = 0,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> List[ArtifactResponse]:
    """
    Get artifacts for a chat.
    
    Args:
        chat_id: Chat UUID
        artifact_type: Optional type filter (code, html, output, file, etc.)
        limit: Maximum number of artifacts
        offset: Number of artifacts to skip
        
    Returns:
        List of artifact objects
    """
    # Validate pagination
    if offset < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Offset must be non-negative"
        )
    if limit < 1 or limit > 1000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Limit must be between 1 and 1000"
        )
    
    try:
        artifacts = await repo.get_artifacts(chat_id, type=artifact_type, limit=limit, offset=offset)
        logger.info(f"Retrieved {len(artifacts)} artifacts for chat {chat_id}")
        
        return [
            ArtifactResponse(
                id=art.id,
                chat_id=art.chat_id,
                message_id=art.message_id if art.message_id else None,
                type=art.type,
                title=art.filename or f"{art.type}_{art.id}",  # Map filename to title
                content=art.content or "",
                language=art.language,
                file_path=None,  # Database doesn't have file_path
                created_at=art.created_at,
                updated_at=art.created_at,  # Use created_at as fallback for updated_at
                metadata=art.metadata
            )
            for art in artifacts
        ]
        
    except Exception as e:
        logger.error(f"Failed to get artifacts for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve artifacts"
        )


@router.post("/chats/{chat_id}/artifacts", response_model=ArtifactResponse, status_code=status.HTTP_201_CREATED, summary="Create artifact")
async def create_artifact(
    chat_id: UUID,
    artifact: ArtifactCreate,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> ArtifactResponse:
    """
    Create a new artifact in a chat.
    
    Args:
        chat_id: Chat UUID
        artifact: Artifact creation data
        
    Returns:
        Created artifact object
        
    Raises:
        404: If chat not found
    """
    try:
        # Convert and validate message_id if provided
        message_uuid = None
        if artifact.message_id:
            try:
                message_uuid = UUID(artifact.message_id)
            except (ValueError, TypeError) as e:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid message_id format: {str(e)}"
                )
        
        new_artifact = await repo.create_artifact(
            chat_id=chat_id,
            type=artifact.type,
            content=artifact.content,
            filename=artifact.filename,
            language=artifact.language,
            message_id=message_uuid,
            artifact_id=artifact.artifact_id,
            metadata=artifact.metadata
        )
        
        logger.info(f"Created {artifact.type} artifact {new_artifact.id} in chat {chat_id}")
        
        return ArtifactResponse(
            id=new_artifact.id,
            chat_id=new_artifact.chat_id,
            message_id=new_artifact.message_id if new_artifact.message_id else None,
            type=new_artifact.type,
            title=new_artifact.filename or f"{new_artifact.type}_{new_artifact.id}",  # Map filename to title
            content=new_artifact.content or "",
            language=new_artifact.language,
            file_path=None,  # Database doesn't have file_path
            created_at=new_artifact.created_at,
            updated_at=new_artifact.created_at,  # Use created_at as fallback for updated_at
            metadata=new_artifact.metadata
        )
        
    except ValueError as e:
        # Chat not found
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found"
        )
    except Exception as e:
        logger.error(f"Failed to create artifact in chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create artifact"
        )


@router.put("/artifacts/update-message-id", response_model=ArtifactUpdateMessageIdResponse, summary="Update artifact message ID")
async def update_artifact_message_id(
    update_request: ArtifactUpdateMessageIdRequest,
    _context: dict = Depends(setup_request_context),
    repo: ChatRepository = Depends(get_chat_repository)
) -> ArtifactUpdateMessageIdResponse:
    """
    Link artifact to a message after PostgreSQL persistence.
    
    Used during streaming when artifact is created before message is persisted.
    Once message is saved to PostgreSQL and gets a UUID, this endpoint links
    the artifact to that message for traceability.
    
    Args:
        update_request: Contains artifact_id and message_id for linking
        
    Returns:
        Update result with count of artifacts linked
        
    Raises:
        404: If artifact not found
        500: If database update fails
    """
    try:
        updated_artifact = await repo.update_artifact_message_id(
            artifact_id=update_request.artifact_id,
            message_id=update_request.message_id
        )
        
        if not updated_artifact:
            # Artifact not found - not necessarily an error if no artifacts were created
            logger.info(f"No artifact found with artifact_id={update_request.artifact_id}")
            return ArtifactUpdateMessageIdResponse(
                success=True,
                updated_count=0,
                message="No artifacts to link for this message",
                artifact_id=update_request.artifact_id,
                message_id=update_request.message_id
            )
        
        logger.info(f"Linked artifact {update_request.artifact_id} to message {update_request.message_id}")
        
        return ArtifactUpdateMessageIdResponse(
            success=True,
            updated_count=1,
            message="Artifact linked to message successfully",
            artifact_id=update_request.artifact_id,
            message_id=update_request.message_id
        )
        
    except Exception as e:
        logger.error(f"Failed to update artifact message ID: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update artifact message ID"
        )


# =============================================================================
# Traceability Endpoints
# =============================================================================

@router.post("/traceability", summary="Save traceability data")
async def save_traceability_data(
    data: Dict[str, Any],
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository)
) -> Dict[str, Any]:
    """
    Save traceability data (message-artifact relationships and indexes).
    
    Traceability data tracks relationships between messages, artifacts, and correlations
    for debugging and audit trail purposes. Stored as versioned JSON.
    
    Args:
        data: Traceability data structure with indexes
        
    Returns:
        Success status
    """
    try:
        # Store traceability data using storage repository
        # For now, we'll use a simple approach - store as metadata in storage
        await storage_repo.save_traceability_data(data)
        
        logger.info(f"Saved traceability data: {data.get('messages', [])[:10]} messages, {len(data.get('artifacts', []))} artifacts")
        
        return {
            "success": True,
            "version": data.get('version', '2.0'),
            "timestamp": data.get('timestamp'),
            "message_count": len(data.get('messages', [])),
            "artifact_count": len(data.get('artifacts', []))
        }
        
    except Exception as e:
        logger.error(f"Failed to save traceability data: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save traceability data"
        )


@router.get("/traceability/{chat_id}", summary="Load traceability data for chat")
async def load_traceability_data(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository)
) -> Dict[str, Any]:
    """
    Load traceability data for a specific chat.
    
    Returns message-artifact relationships and tracking indexes.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Traceability data structure with indexes
    """
    try:
        data = await storage_repo.load_traceability_data(str(chat_id))
        
        if not data:
            # Return empty structure if no data exists
            return {
                "version": "2.0",
                "timestamp": None,
                "messages": [],
                "artifacts": [],
                "correlationIndex": [],
                "messageArtifactsIndex": [],
                "artifactMessageIndex": [],
                "chatMessagesIndex": [],
                "chatArtifactsIndex": []
            }
        
        logger.info(f"Loaded traceability data for chat {chat_id}")
        return data
        
    except Exception as e:
        logger.error(f"Failed to load traceability data for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load traceability data"
        )


# =============================================================================
# Trail State Endpoints (Execution Trail UI Persistence)
# =============================================================================

@router.post("/trails/{chat_id}", summary="Save trail state for chat")
async def save_trail_state(
    chat_id: str,
    trail_data: Dict[str, Any],
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository)
) -> Dict[str, Any]:
    """
    Save trail container state for a chat.
    
    Trail state includes DOM snapshots and metadata for execution trail UI.
    Allows trails to persist across frontend restarts.
    
    Args:
        chat_id: Chat ID
        trail_data: Trail state structure with trails array and metadata
        
    Returns:
        Success status
    """
    try:
        await storage_repo.save_trail_state(chat_id, trail_data)
        
        logger.info(f"Saved trail state for chat {chat_id}: {len(trail_data.get('trails', []))} trails")
        
        return {
            "success": True,
            "chat_id": chat_id,
            "trail_count": len(trail_data.get('trails', [])),
            "saved_at": trail_data.get('savedAt')
        }
        
    except Exception as e:
        logger.error(f"Failed to save trail state for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save trail state"
        )


@router.get("/trails/{chat_id}", summary="Load trail state for chat")
async def load_trail_state(
    chat_id: str,
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository)
) -> Dict[str, Any]:
    """
    Load trail container state for a chat.
    
    Returns trail state including DOM snapshots and metadata.
    
    Args:
        chat_id: Chat ID
        
    Returns:
        Trail state structure or empty structure if not found
    """
    try:
        data = await storage_repo.load_trail_state(chat_id)
        
        if not data:
            # Return empty structure if no trails exist
            return {
                "trails": [],
                "nextTrailNumber": 1,
                "savedAt": None
            }
        
        logger.info(f"Loaded trail state for chat {chat_id}: {len(data.get('trails', []))} trails")
        return data
        
    except Exception as e:
        logger.error(f"Failed to load trail state for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load trail state"
        )


@router.delete("/trails/{chat_id}", summary="Delete trail state for chat")
async def delete_trail_state(
    chat_id: str,
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository)
) -> Dict[str, Any]:
    """
    Delete trail container state for a chat.
    
    Args:
        chat_id: Chat ID
        
    Returns:
        Success status
    """
    try:
        deleted = await storage_repo.delete_trail_state(chat_id)
        
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Trail state not found for chat {chat_id}"
            )
        
        logger.info(f"Deleted trail state for chat {chat_id}")
        
        return {
            "success": True,
            "chat_id": chat_id
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete trail state for chat {chat_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete trail state"
        )


# =============================================================================
# Statistics & Health Endpoints
# =============================================================================

@router.get("/stats", summary="Get storage statistics")
async def get_storage_stats(
    _context: dict = Depends(setup_request_context),
    storage_repo: StorageRepository = Depends(get_storage_repository),
    chat_repo: ChatRepository = Depends(get_chat_repository)
) -> Dict[str, Any]:
    """
    Get storage statistics across all chats and artifacts.
    
    Returns:
        Dict with artifact counts, storage sizes, and timestamps
    """
    try:
        stats = await storage_repo.get_storage_statistics()
        
        # Get counts using repository methods (maintain abstraction)
        # Note: This requires adding get_total_counts() method to ChatRepository
        # For now, we'll use a workaround by fetching all chats with limit
        all_chats = await chat_repo.list_chats(limit=10000, offset=0)
        chat_count = len(all_chats)
        
        # Get message count - sum from all chats
        message_count = 0
        for chat in all_chats:
            chat_stats = await chat_repo.get_chat_statistics(chat.id)
            message_count += chat_stats.get('message_count', 0)
        
        return {
            "total_chats": chat_count,
            "total_messages": message_count,
            "total_artifacts": stats.get('total_artifacts', 0),
            "total_size": stats.get('total_content_bytes', 0),
            "size": stats.get('total_content_bytes', 0),
            "artifact_counts_by_type": {
                "code": stats.get('code_count', 0),
                "html": stats.get('html_count', 0),
                "output": stats.get('output_count', 0),
                "file": stats.get('file_count', 0),
                "text": stats.get('text_count', 0),
                "markdown": stats.get('markdown_count', 0),
                "json": stats.get('json_count', 0)
            },
            "last_artifact_at": stats.get('last_artifact_at')
        }
        
    except Exception as e:
        logger.error(f"Failed to get storage stats: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve storage statistics"
        )


@router.get("/health", summary="Storage health check")
async def health_check(
    db: DatabaseConnection = Depends(get_database)
) -> Dict[str, Any]:
    """
    Check storage/database health.
    
    Returns:
        Health status with database connectivity and table counts
    """
    try:
        health = await db.health_check()
        
        return {
            "status": "ok" if health['healthy'] else "degraded",
            "healthy": health['healthy'],
            "connected": health['connected'],
            "counts": health.get('counts', {}),
            "pool_stats": health.get('pool_stats', {})
        }
        
    except Exception as e:
        logger.error(f"Storage health check failed: {e}", exc_info=True)
        return {
            "status": "error",
            "healthy": False,
            "error": str(e)
        }
