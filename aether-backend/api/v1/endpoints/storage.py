"""
Storage Endpoints (PostgreSQL)

@.architecture
Incoming: api/v1/router.py, api/dependencies.py::setup_request_context, HTTP clients --- {http_request, json}
Processing: validate storage payloads, orchestrate repository access, persist chat and trace records --- {JOB_DELETE_FROM_DB, JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
Outgoing: data/database/repositories/chat.py, data/database/repositories/storage.py, FastAPI responses --- {Dict[str, Any], json}
"""

from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, status
from uuid import UUID

from core.exceptions import DomainException
from api.dependencies import setup_request_context, get_database, get_chat_service, get_summary_service, get_storage_service
from api.v1.schemas.chat import (
    ChatCreate,
    ChatUpdate,
    ChatResponse,
    MessageCreate,
    MessageResponse,
    MessageLLMMetadataResponse,
    ArtifactCreate,
    ArtifactResponse,
    ArtifactUpdateMessageIdRequest,
    ArtifactUpdateMessageIdResponse,
    ArtifactUpdate
)
from api.v1.schemas.chat_context import (
    ChatSummaryCreate,
    ChatSummaryResponse
)
# Removed: TrailStateEnvelope (legacy DOM snapshot schema)
from monitoring import get_logger
from application.storage.storage_service import StorageService

logger = get_logger(__name__)
router = APIRouter(tags=["storage"], prefix="/storage")


# =============================================================================
# Chat Endpoints
# =============================================================================

@router.get("/chat/list", response_model=List[ChatResponse], summary="List all chats")
async def list_chats(
    skip: int = 0,
    limit: int = 50,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        chats = await chat_service.list_chats(skip=skip, limit=limit)
        logger.info("Retrieved %d chats (skip=%d, limit=%d)", len(chats), skip, limit)
        return [_chat_summary_to_response(chat) for chat in chats]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list chats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve chats"
        )


@router.post("/chat/create", response_model=ChatResponse, status_code=status.HTTP_201_CREATED, summary="Create chat")
async def create_chat(
    chat: ChatCreate,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
) -> ChatResponse:
    """
    Create a new chat.
    
    Args:
        chat: Chat creation data
        
    Returns:
        Created chat object
    """
    try:
        new_chat = await chat_service.create_chat(
            chat.title,
            description=chat.description,
            metadata=chat.metadata
        )
        logger.info("Created chat %s with title '%s'", new_chat.id, chat.title)
        return _chat_summary_to_response(new_chat)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to create chat: %s", e, exc_info=True)
        # Fail-fast on infra outage (common in dev): Supabase/Kong not reachable.
        # This surfaces a precise root cause instead of a generic 500.
        msg = str(e) or ""
        if "Connection refused" in msg or "ConnectError" in msg:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=(
                    "Storage backend unavailable (connection refused). "
                    "Ensure Docker Desktop is running and the local Supabase stack is up (port 54321)."
                ),
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create chat"
        )


@router.get("/chat/get/{chat_id}", response_model=ChatResponse, summary="Get chat by ID")
async def get_chat(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        chat = await chat_service.get_chat(chat_id)
        if not chat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        return _chat_summary_to_response(chat)
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve chat"
        )


@router.put("/chat/update/{chat_id}", response_model=ChatResponse, summary="Update chat")
async def update_chat(
    chat_id: UUID,
    update: ChatUpdate,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        updated_chat = await chat_service.update_chat(
            chat_id, 
            title=update.title,
            description=update.description,
            metadata=update.metadata,
            archived=update.archived
        )
        if not updated_chat:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        logger.info("Updated chat %s title to '%s'", chat_id, update.title)
        return _chat_summary_to_response(updated_chat)
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to update chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update chat"
        )


@router.delete("/chat/delete/{chat_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete chat")
async def delete_chat(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
):
    """
    Delete chat and all associated messages/artifacts (CASCADE).
    
    Args:
        chat_id: Chat UUID
        
    Raises:
        404: If chat not found
    """
    try:
        deleted = await chat_service.delete_chat(chat_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat {chat_id} not found"
            )
        logger.info("Deleted chat %s and all associated data", chat_id)
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete chat"
        )


# =============================================================================
# Message Endpoints
# =============================================================================

@router.get("/message/list/{chat_id}", response_model=List[MessageResponse], summary="List messages")
async def get_messages(
    chat_id: UUID,
    limit: int = 100,
    offset: int = 0,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        messages = await chat_service.list_messages(chat_id, limit=limit, offset=offset)
        logger.info("Retrieved %d messages for chat %s", len(messages), chat_id)
        return [_message_to_response(message) for message in messages]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get messages for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve messages"
        )


@router.get(
    "/message/llm-metadata/get/{message_id}",
    response_model=MessageLLMMetadataResponse,
    summary="Get LLM metadata for message",
)
async def get_message_llm_metadata(
    message_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service),
) -> MessageLLMMetadataResponse:
    """
    Get LLM metadata for a message.
    """
    try:
        message = await chat_service.get_message(message_id)
        if not message:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Message {message_id} not found"
            )
        return MessageLLMMetadataResponse(
            message_id=message.id,
            llm_model=getattr(message, "llm_model", None),
            llm_provider=getattr(message, "llm_provider", None),
            tokens_used=getattr(message, "tokens_used", None),
        )
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get LLM metadata for message %s: %s", message_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve LLM metadata"
        )


@router.post("/message/create/{chat_id}", response_model=MessageResponse, status_code=status.HTTP_201_CREATED, summary="Create message")
async def create_message(
    chat_id: UUID,
    message: MessageCreate,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        new_message = await chat_service.create_message(
            chat_id=chat_id,
            role=message.role,
            content=message.content,
            llm_model=message.llm_model,
            llm_provider=message.llm_provider,
            tokens_used=message.tokens_used,
            metadata=message.metadata,
            parent_message_id=message.parent_message_id,
        )
        
        logger.info("Created %s message %s in chat %s", message.role, new_message.id, chat_id)
        
        return _message_to_response(new_message)
        
    except ValueError:
        # Chat not found
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to create message in chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create message"
        )


# =============================================================================
# Artifact Endpoints
# =============================================================================

@router.get("/artifact/list/{chat_id}", response_model=List[ArtifactResponse], summary="List artifacts")
async def get_artifacts(
    chat_id: UUID,
    artifact_type: str = None,
    limit: int = 100,
    offset: int = 0,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        artifacts = await chat_service.list_artifacts(
            chat_id,
            artifact_type=artifact_type,
            limit=limit,
            offset=offset,
        )
        logger.info("Retrieved %d artifacts for chat %s", len(artifacts), chat_id)
        
        return [_artifact_to_response(artifact) for artifact in artifacts]
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get artifacts for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve artifacts"
        )


@router.post("/artifact/create/{chat_id}", response_model=ArtifactResponse, status_code=status.HTTP_201_CREATED, summary="Create artifact")
async def create_artifact(
    chat_id: UUID,
    artifact: ArtifactCreate,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        message_uuid = None
        if artifact.message_id:
            try:
                # Frontend may send composite IDs like "uuid_seq_role", extract UUID part
                message_id_str = artifact.message_id
                if '_' in message_id_str:
                    # Extract first part (the actual UUID)
                    message_id_str = message_id_str.split('_')[0]
                message_uuid = UUID(message_id_str)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid message_id format. Expected UUID."
                )
        
        # CONTRACT ENFORCEMENT: Only OUTPUT artifacts require trail linkage
        # Code artifacts are optional (backend doesn't emit trail.artifact_linked for code)
        # Output artifacts (computer:output) MUST link to trail nodes for UX consistency
        requires_trail_linkage = (artifact.type == "output")
        
        if requires_trail_linkage and (not artifact.subgroup_id or not artifact.node_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"CONTRACT VIOLATION: {artifact.type} artifacts require trail linkage. "
                    f"subgroup_id and node_id are required but got: "
                    f"subgroup_id={artifact.subgroup_id}, node_id={artifact.node_id}. "
                    f"Backend must emit trail.artifact_linked before artifact persistence."
                )
            )
        
        subgroup_uuid = None
        if artifact.subgroup_id:
            try:
                subgroup_uuid = UUID(artifact.subgroup_id)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid subgroup_id format. Expected UUID."
                )
        
        node_uuid = None
        if artifact.node_id:
            try:
                node_uuid = UUID(artifact.node_id)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid node_id format. Expected a valid UUID."
                )
        
        logger.info(
            f"DIAGNOSTIC: Creating artifact with node linkage - "
            f"artifact_id={artifact.artifact_id}, node_id={artifact.node_id}, subgroup_id={artifact.subgroup_id}"
        )
        
        metadata = artifact.metadata or {}
        
        # ARCHITECTURAL FIX: Resolve execution_group from top-level field or metadata.
        # Frontend sends execution_group as top-level field (preferred) or in metadata.
        execution_group = artifact.execution_group
        if not execution_group and metadata:
            execution_group = metadata.get("execution_group") or metadata.get("executionGroup")
        
        new_artifact = await chat_service.create_artifact(
            chat_id=chat_id,
            artifact_type=artifact.type,
            content=artifact.content,
            filename=artifact.filename,
            language=artifact.language,
            artifact_id=artifact.artifact_id,
            message_id=message_uuid,
            metadata=metadata,
            subgroup_id=subgroup_uuid,
            node_id=node_uuid,
            execution_group=execution_group,
        )
        
        logger.info(
            f"Created {artifact.type} artifact {new_artifact.id} in chat {chat_id} - "
            f"persisted_node_id={getattr(new_artifact, 'node_id', None)}"
        )
        
        return _artifact_to_response(new_artifact)
        
    except (HTTPException, DomainException):
        # Preserve contract-level errors (4xx) instead of masking them as 500s.
        raise
    except ValueError:
        # Chat not found
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chat not found"
        )
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to create artifact in chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create artifact"
        )


@router.put("/artifact/link-message", response_model=ArtifactUpdateMessageIdResponse, summary="Update artifact message ID")
async def update_artifact_message_id(
    update_request: ArtifactUpdateMessageIdRequest,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
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
        updated_artifacts = await chat_service.update_artifact_message_id(
            artifact_id=update_request.artifact_id,
            message_id=update_request.message_id,
        )
        updated_list = list(updated_artifacts)
        updated_count = len(updated_list)
        
        if updated_count == 0:
            # Artifact not found - not necessarily an error if no artifacts were created
            logger.info("No artifact found with artifact_id=%s", update_request.artifact_id)
            try:
                from monitoring.metrics import get_registry
                metrics = get_registry()
                metrics.counter('aether_artifact_link_events_total', 'Artifact link events', labels=['result']).inc(result='failure')
            except Exception as e:
                logger.warning("Failed to record metric: %s", e)
            return ArtifactUpdateMessageIdResponse(
                success=True,
                updated_count=0,
                message="No artifacts to link for this message",
                artifact_id=update_request.artifact_id,
                message_id=update_request.message_id
            )
        
        logger.info(
            "Linked %d artifact(s) with identifier %s to message %s",
            updated_count,
            update_request.artifact_id,
            update_request.message_id,
        )
        try:
            from monitoring.metrics import get_registry
            metrics = get_registry()
            metrics.counter('aether_artifact_link_events_total', 'Artifact link events', labels=['result']).inc(result='success')
        except Exception as e:
            logger.warning("Failed to record metric: %s", e)
        
        return ArtifactUpdateMessageIdResponse(
            success=True,
            updated_count=updated_count,
            message="Artifact(s) linked to message successfully",
            artifact_id=update_request.artifact_id,
            message_id=update_request.message_id
        )
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to update artifact message ID: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update artifact message ID"
        )


@router.get("/artifact/get/{artifact_id}", response_model=ArtifactResponse, summary="Get artifact by ID")
async def get_artifact(
    artifact_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
) -> ArtifactResponse:
    """
    Get artifact by ID.
    
    Args:
        artifact_id: Artifact UUID
        
    Returns:
        Artifact object
        
    Raises:
        404: If artifact not found
    """
    try:
        artifact = await chat_service.get_artifact(artifact_id)
        if not artifact:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Artifact {artifact_id} not found"
            )
        
        logger.info("Retrieved artifact %s", artifact_id)
        return _artifact_to_response(artifact)
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get artifact %s: %s", artifact_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve artifact"
        )


@router.put("/artifact/update/{artifact_id}", response_model=ArtifactResponse, summary="Update artifact")
async def update_artifact(
    artifact_id: UUID,
    update: ArtifactUpdate,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
) -> ArtifactResponse:
    """
    Update artifact content, filename, language, or metadata.
    
    Args:
        artifact_id: Artifact UUID
        update: Fields to update
        
    Returns:
        Updated artifact object
        
    Raises:
        404: If artifact not found
    """
    try:
        updated_artifact = await chat_service.update_artifact(
            artifact_id=artifact_id,
            content=update.content,
            filename=update.filename,
            language=update.language,
            metadata=update.metadata,
        )
        
        if not updated_artifact:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Artifact {artifact_id} not found"
            )
        
        logger.info("Updated artifact %s", artifact_id)
        return _artifact_to_response(updated_artifact)
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to update artifact %s: %s", artifact_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update artifact"
        )


@router.delete("/artifact/delete/{artifact_id:path}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete artifact")
async def delete_artifact(
    artifact_id: str,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
):
    """
    Delete artifact by ID.
    
    Accepts both plain UUIDs and composite IDs (``uuid:type:index``)
    that the frontend uses to identify specific code/output blocks
    within a message.
    
    Args:
        artifact_id: Artifact UUID or composite ``uuid:type:index``
        
    Raises:
        404: If artifact not found
    """
    try:
        # Frontend sends composite IDs like "uuid:code:3" or "uuid:output:2".
        # Extract the UUID portion for the DB lookup.
        raw = artifact_id.strip()
        uuid_str = raw.split(":")[0] if ":" in raw else raw
        try:
            parsed_id = UUID(uuid_str)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid artifact ID: '{raw}' — could not parse UUID from '{uuid_str}'"
            )
        
        deleted = await chat_service.delete_artifact(parsed_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Artifact {parsed_id} not found"
            )
        
        logger.info("Deleted artifact %s (requested: %s)", parsed_id, raw)
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to delete artifact %s: %s", artifact_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete artifact"
        )


@router.get("/artifact/export/{artifact_id}", summary="Export artifact content")
async def export_artifact(
    artifact_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
):
    """
    Export artifact content as downloadable file.
    
    Args:
        artifact_id: Artifact UUID
        
    Returns:
        File download response with appropriate content type
        
    Raises:
        404: If artifact not found
    """
    from fastapi.responses import Response
    
    try:
        artifact = await chat_service.get_artifact(artifact_id)
        if not artifact:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Artifact {artifact_id} not found"
            )
        
        # Determine content type based on artifact type/language
        content_type = "text/plain"
        if artifact.language:
            lang = artifact.language.lower()
            if lang in ("python", "py"):
                content_type = "text/x-python"
            elif lang in ("javascript", "js"):
                content_type = "application/javascript"
            elif lang == "html":
                content_type = "text/html"
            elif lang == "json":
                content_type = "application/json"
            elif lang in ("markdown", "md"):
                content_type = "text/markdown"
        
        # Determine filename
        filename = artifact.filename or f"artifact_{artifact_id}.txt"
        if artifact.language and not filename.endswith(f".{artifact.language}"):
            filename = f"{filename}.{artifact.language}"
        
        logger.info("Exporting artifact %s as %s", artifact_id, filename)
        
        return Response(
            content=artifact.content or "",
            media_type=content_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            }
        )
        
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to export artifact %s: %s", artifact_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to export artifact"
        )


@router.get("/artifact/list/message/{message_id}", response_model=List[ArtifactResponse], summary="Get artifacts for message")
async def get_message_artifacts(
    message_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
) -> List[ArtifactResponse]:
    """
    Get artifacts linked to a specific message.
    
    Args:
        message_id: Message UUID
        
    Returns:
        List of artifact objects
    """
    try:
        artifacts = await chat_service.get_message_artifacts(message_id)
        logger.info("Retrieved %d artifacts for message %s", len(artifacts), message_id)
        return [_artifact_to_response(artifact) for artifact in artifacts]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get artifacts for message %s: %s", message_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve artifacts"
        )


@router.get("/artifact/source/{artifact_id}", response_model=MessageResponse, summary="Get artifact source")
async def get_artifact_source(
    artifact_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service = Depends(get_chat_service)
) -> MessageResponse:
    """
    Get the message that created an artifact.
    
    Args:
        artifact_id: Artifact UUID
        
    Returns:
        Source message object
        
    Raises:
        404: If source not found
    """
    try:
        message = await chat_service.get_artifact_source(artifact_id)
        if not message:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source message not found"
            )
        logger.info("Retrieved source message %s for artifact %s", message.id, artifact_id)
        return _message_to_response(message)
    except (HTTPException, DomainException):
        raise
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get source for artifact %s: %s", artifact_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve artifact source"
        )


# =============================================================================
# Traceability Endpoints
# =============================================================================

@router.post("/traceability/save", summary="Save traceability data")
async def save_traceability_data(
    data: Dict[str, Any],
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
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
        await storage_service.save_traceability_data(data)
        
        return {
            "success": True,
            "version": data.get('version', '2.0'),
            "timestamp": data.get('timestamp'),
            "message_count": len(data.get('messages', [])),
            "artifact_count": len(data.get('artifacts', []))
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to save traceability data: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save traceability data"
        )


@router.get("/traceability/load/{chat_id}", summary="Load traceability data for chat")
async def load_traceability_data(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
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
        return await storage_service.load_traceability_data(str(chat_id))
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to load traceability data for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load traceability data"
        )


# =============================================================================
# Trail Hierarchy Endpoints (NEW ARCHITECTURE - Groups → Subgroups → Nodes)
# =============================================================================


@router.get("/trail/hierarchy/get/{chat_id}", summary="Get trail hierarchy for chat")
async def get_trail_hierarchy(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> List[Dict[str, Any]]:
    """
    Get complete trail hierarchy for a chat (groups → subgroups → nodes).
    """
    try:
        hierarchy = await storage_service.get_trail_hierarchy(chat_id)
        logger.info("Retrieved trail hierarchy for chat %s (groups=%d)", chat_id, len(hierarchy))
        return hierarchy
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get trail hierarchy for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve trail hierarchy"
        )


@router.get("/trail/group/list/{chat_id}", summary="List groups for chat")
async def list_groups(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> List[Dict[str, Any]]:
    """
    Get all groups for a chat (hierarchical trail schema).
    Groups only exist when artifacts were used in that turn.
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        List of group records with metadata
    """
    try:
        groups = await storage_service.get_groups_by_chat(chat_id)
        logger.info("Retrieved %d groups for chat %s", len(groups), chat_id)
        return groups
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list groups for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve groups"
        )


@router.get("/trail/session-map/{chat_id}", summary="Get complete chat session map")
async def get_chat_session_map(
    chat_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> Dict[str, Any]:
    """
    Get complete linear timeline map for a chat session.
    
    This endpoint provides a comprehensive, chronologically ordered view of ALL
    events in a chat: messages, artifacts, trails, files, and context.
    
    Purpose:
    - Complete chat restoration with zero context loss
    - Cross-chat context and reasoning
    - Export/import functionality
    - Audit trail and debugging
    
    Args:
        chat_id: Chat UUID
        
    Returns:
        Session map conforming to chat_session_map.schema.json
        
    Structure:
        {
          "chat_id": "uuid",
          "title": "Chat Title",
          "created_at": "ISO8601",
          "updated_at": "ISO8601",
          "metadata": {
            "total_messages": 10,
            "total_artifacts": 5,
            "total_trails": 3,
            ...
          },
          "timeline": [
            {"type": "message", "sequence": 1, ...},
            {"type": "artifact", "sequence": 2, ...},
            {"type": "trail", "sequence": 3, ...}
          ],
          "indexes": {
            "messages_by_id": {...},
            "artifacts_by_id": {...},
            "trails_by_group": {...}
          }
        }
    """
    try:
        from config.settings import get_settings
        settings = get_settings()
        
        session_map = await storage_service.get_chat_session_map(chat_id, settings)
        
        logger.info(
            f"Generated session map for chat {chat_id}",
            extra={
                "chat_id": str(chat_id),
                "timeline_events": len(session_map.get("timeline", [])),
                "total_messages": session_map.get("metadata", {}).get("total_messages", 0),
                "total_artifacts": session_map.get("metadata", {}).get("total_artifacts", 0)
            }
        )
        
        return session_map
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to generate session map for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate session map. Check server logs for details."
        )



@router.get("/trail/subgroup/list/{group_id}", summary="List subgroups for group")
async def list_subgroups(
    group_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> List[Dict[str, Any]]:
    """
    Get all subgroups for a group.
    
    Args:
        group_id: Group UUID
        
    Returns:
        List of subgroup records
    """
    try:
        subgroups = await storage_service.get_subgroups_by_group(group_id)
        logger.info("Retrieved %d subgroups for group %s", len(subgroups), group_id)
        return subgroups
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list subgroups for group %s: %s", group_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve subgroups"
        )


@router.get("/trail/node/list/{subgroup_id}", summary="List nodes for subgroup")
async def list_nodes(
    subgroup_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> List[Dict[str, Any]]:
    """
    Get all nodes for a subgroup (should always be exactly 3).
    
    Args:
        subgroup_id: Subgroup UUID
        
    Returns:
        List of 3 node records (writing, executing, output)
    """
    try:
        nodes = await storage_service.get_nodes_by_subgroup(subgroup_id)
        
        if len(nodes) != 3:
            logger.warning("Subgroup %s has %d nodes, expected 3", subgroup_id, len(nodes))
        
        logger.info("Retrieved %d nodes for subgroup %s", len(nodes), subgroup_id)
        return nodes
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list nodes for subgroup %s: %s", subgroup_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve nodes"
        )


@router.get("/trail/subgroup/artifact/list/{subgroup_id}", summary="List artifacts for subgroup")
async def list_subgroup_artifacts(
    subgroup_id: UUID,
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> List[Dict[str, Any]]:
    """
    Get artifacts linked to a subgroup (code + output only).
    """
    try:
        artifacts = await storage_service.get_subgroup_artifacts(subgroup_id)
        logger.info("Retrieved %d artifacts for subgroup %s", len(artifacts), subgroup_id)
        return artifacts
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list artifacts for subgroup %s: %s", subgroup_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve subgroup artifacts"
        )


# =============================================================================
# REMOVED: Legacy Trail State Endpoints (DOM Snapshot Persistence)
# =============================================================================
# 
# The following endpoints were removed as per architecture cleanup:
#   - POST   /trails/{chat_id}  (save_trail_state)
#   - GET    /trails/{chat_id}  (load_trail_state)  
#   - DELETE /trails/{chat_id}  (delete_trail_state)
#
# REASON FOR REMOVAL:
# - Violated backend independence principle (relied on DOM snapshots)
# - Duplicated source of truth (conflicted with hierarchical schema)
# - Frontend should not persist HTML snapshots
# - No backward compatibility per deployment requirements
#
# MIGRATION PATH:
# Frontend must use the new hierarchical trail endpoints:
#   - GET /api/storage/trail/hierarchy/get/{chat_id}    (load complete hierarchy)
#   - GET /api/storage/chats/{chat_id}/groups           (list groups)
#   - GET /api/storage/groups/{group_id}/subgroups      (list subgroups)
#   - GET /api/storage/subgroups/{subgroup_id}/nodes    (list nodes)
#   - GET /api/storage/subgroups/{subgroup_id}/artifacts (list artifacts)
#
# The trail hierarchy is built in real-time via WebSocket events from:
#   - ws/application/trail_service.py
#   - ws/application/stream_service.py
#
# All trail persistence is now handled by the backend at:
#   - data/database/repositories/trail.py
# =============================================================================#


# =============================================================================
# Statistics & Health Endpoints
# =============================================================================

@router.get("/stats", summary="Get storage statistics")
async def get_storage_stats(
    _context: dict = Depends(setup_request_context),
    storage_service: StorageService = Depends(get_storage_service)
) -> Dict[str, Any]:
    """
    Get storage statistics across all chats and artifacts.
    
    Returns:
        Dict with artifact counts, storage sizes, and timestamps
    """
    try:
        stats = await storage_service.get_storage_statistics()
        
        return {
            "total_chats": stats.get("total_chats", 0),
            "total_messages": stats.get("total_messages", 0),
            "total_artifacts": stats.get("total_artifacts", 0),
            "total_size": stats.get("total_content_bytes", 0),
            "size": stats.get("total_content_bytes", 0),
            "artifact_counts_by_type": stats.get("artifact_counts_by_type", {}),
            "last_artifact_at": stats.get("last_artifact_at")
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to get storage stats: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve storage statistics"
        )


@router.get("/health", summary="Storage health check")
async def health_check(
    db = Depends(get_database)
) -> Dict[str, Any]:
    """
    Check storage/database health.
    
    Returns:
        Health status with database connectivity and table counts
    """
    try:
        health = await db.health_check()
        healthy = bool(health.get('healthy'))
        connected = bool(health.get('connected', healthy))
        status = "ok" if healthy and connected else "degraded"
        return {
            "status": status,
            "healthy": healthy,
            "connected": connected,
            "counts": health.get('counts', {}),
            "pool_stats": health.get('pool_stats', {}),
            "details": {
                "error": health.get('error'),
                "metadata": {k: v for k, v in health.items() if k not in {'healthy', 'connected', 'counts', 'pool_stats'}}
            }
        }
        
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Storage health check failed: %s", e, exc_info=True)
        return {
            "status": "error",
            "healthy": False,
            "error": "Health check failed. Check server logs for details."
        }


# =============================================================================
# Chat References & Summaries Endpoints
# =============================================================================

@router.post("/summary/create/{chat_id}", response_model=ChatSummaryResponse, summary="Generate chat summary")
async def summarize_chat(
    chat_id: UUID,
    request: ChatSummaryCreate,
    summary_service = Depends(get_summary_service),
    _context: dict = Depends(setup_request_context)
) -> ChatSummaryResponse:
    """Generate or regenerate a chat summary using LLM."""
    try:
        summary = await summary_service.generate_summary(
            chat_id=chat_id,
            summary_type=request.summary_type,
            force_regenerate=request.force_regenerate
        )
        return ChatSummaryResponse(**summary)
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to generate summary for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate summary. Check server logs for details."
        )


@router.get("/summary/list/{chat_id}", response_model=List[ChatSummaryResponse], summary="List chat summaries")
async def list_chat_summaries(
    chat_id: UUID,
    summary_service = Depends(get_summary_service),
    _context: dict = Depends(setup_request_context)
) -> List[ChatSummaryResponse]:
    """Get all summaries for a chat."""
    try:
        summaries = await summary_service.list_summaries(chat_id)
        return [ChatSummaryResponse(**s) for s in summaries]
    except (HTTPException, DomainException):
        raise
    except Exception as e:
        logger.error("Failed to list summaries for chat %s: %s", chat_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list summaries. Check server logs for details."
        )


# =============================================================================
# NOTE: Chat references and reference-graph endpoints are in
# api/v1/endpoints/chat_references.py to avoid duplicate operation IDs
# =============================================================================


# Response mappers (operate on duck-typed domain objects)


def _chat_summary_to_response(summary: Any) -> ChatResponse:
    return ChatResponse(
        id=summary.id,
        title=summary.title,
        description=getattr(summary, "description", None),
        created_at=summary.created_at,
        updated_at=summary.updated_at,
        message_count=summary.message_count,
        metadata=getattr(summary, "metadata", None),
        archived=getattr(summary, "archived", False),
    )


def _message_to_response(message: Any) -> MessageResponse:
    return MessageResponse(
        id=message.id,
        chat_id=message.chat_id,
        role=message.role,
        content=message.content,
        created_at=message.created_at,
        metadata=getattr(message, "metadata", None),
        parent_message_id=getattr(message, "parent_message_id", None),
        token_count=getattr(message, "token_count", None),
    )


def _artifact_to_response(artifact: Any) -> ArtifactResponse:
    filename = getattr(artifact, "filename", None)
    created_at = getattr(artifact, "created_at", None)
    # ARCHITECTURAL FIX: Resolve execution_group from top-level field or metadata.
    # The DB column may be NULL for legacy artifacts, but metadata stores it from streaming.
    execution_group = getattr(artifact, "execution_group", None)
    if not execution_group:
        metadata = getattr(artifact, "metadata", None) or {}
        execution_group = metadata.get("execution_group") or metadata.get("executionGroup")
    return ArtifactResponse(
        id=artifact.id,
        chat_id=artifact.chat_id,
        message_id=getattr(artifact, "message_id", None),
        type=artifact.type,
        title=filename or f"{artifact.type}_{artifact.id}",
        content=getattr(artifact, "content", None) or "",
        language=getattr(artifact, "language", None),
        artifact_id=getattr(artifact, "artifact_id", None),  # Include dedup ID
        filename=filename,  # ARCHITECTURAL FIX: Include original filename for frontend display
        file_path=None,
        created_at=created_at,
        updated_at=created_at,
        metadata=getattr(artifact, "metadata", None),
        # Include trail linkage fields for frontend restoration
        subgroup_id=getattr(artifact, "subgroup_id", None),
        node_id=getattr(artifact, "node_id", None),
        # ARCHITECTURAL FIX: Include execution_group for frontend grouping
        execution_group=execution_group,
    )
