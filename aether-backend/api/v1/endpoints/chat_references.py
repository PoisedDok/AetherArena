# @.architecture
# Incoming: HTTP requests for chat reference CRUD --- {FastAPI request, json}
# Processing: Validate payloads and persist/query chat references --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_SAVE_TO_DB, JOB_QUERY_DB}
# Outgoing: JSON responses for chat reference endpoints --- {Dict[str, Any], json}

"""
Chat Reference Endpoints

Manages references between chats for cross-chat context linking.
"""

from typing import Dict, Any, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from core.exceptions import DomainException
from api.dependencies import setup_request_context, get_chat_service
from api.v1.schemas.chat_context import ChatReferenceCreate, ChatReferenceResponse
from application.chat.service import ChatService
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["storage"], prefix="/storage/chat")

def _to_reference_response(ref: Dict[str, Any]) -> ChatReferenceResponse:
    return ChatReferenceResponse(
        id=ref["id"],
        source_chat_id=ref["source_chat_id"],
        target_chat_id=ref["target_chat_id"],
        reference_type=ref.get("reference_type", "context"),
        metadata=ref.get("metadata") or {},
        created_by=ref.get("created_by", "user"),
        created_at=ref.get("created_at"),
    )

@router.post(
    "/reference/create/{chat_id}",
    response_model=ChatReferenceResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Attach a chat reference",
    openapi_extra={"is_agent_tool": True})
async def create_chat_reference(
    chat_id: UUID,
    payload: ChatReferenceCreate,
    _context: dict = Depends(setup_request_context),
    chat_service: ChatService = Depends(get_chat_service),
) -> ChatReferenceResponse:
    try:
        existing = await chat_service.get_chat_reference_by_chats(chat_id, payload.target_chat_id)
        if existing:
            return _to_reference_response(existing)

        ref = await chat_service.create_chat_reference(
            source_chat_id=chat_id,
            target_chat_id=payload.target_chat_id,
            reference_type=payload.reference_type,
            metadata=payload.metadata,
            created_by=payload.created_by,
        )
        return _to_reference_response(ref)
    except (HTTPException, DomainException):
        raise
    except Exception as exc:
        logger.error("Failed to create chat reference: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create chat reference",
        )

@router.get(
    "/reference/list/{chat_id}",
    response_model=List[ChatReferenceResponse],
    summary="List chat references",
    openapi_extra={"is_agent_tool": True})
async def list_chat_references(
    chat_id: UUID,
    direction: str = "both",
    limit: int = 100,
    offset: int = 0,
    _context: dict = Depends(setup_request_context),
    chat_service: ChatService = Depends(get_chat_service),
) -> List[ChatReferenceResponse]:
    try:
        refs = await chat_service.list_chat_references(
            chat_id=chat_id,
            direction=direction,
            limit=limit,
            offset=offset,
        )
        return [_to_reference_response(ref) for ref in refs]
    except Exception as exc:
        logger.error("Failed to list chat references: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list chat references",
        )

@router.delete(
    "/reference/delete/{reference_id}",
    response_model=Dict[str, Any],
    summary="Remove a chat reference",
    openapi_extra={"is_agent_tool": True})
async def delete_chat_reference(
    reference_id: UUID,
    _context: dict = Depends(setup_request_context),
    chat_service: ChatService = Depends(get_chat_service),
) -> Dict[str, Any]:
    try:
        deleted = await chat_service.delete_chat_reference(reference_id)
        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Chat reference {reference_id} not found",
            )
        return {"deleted": True, "reference_id": str(reference_id)}
    except (HTTPException, DomainException):
        raise
    except Exception as exc:
        logger.error("Failed to delete chat reference %s: %s", reference_id, exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete chat reference",
        )
