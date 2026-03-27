"""
Document Processing Endpoints (Docling)

Exposes the in-process Docling pipeline via HTTP for deterministic, fail-fast testing and UI workflows.

Notes:
- Docling runs in-process (no external service). It is the canonical document OCR/conversion path.
- This replaces the legacy notion of a separate `/v1/ocr/*` API surface.

@.architecture
Incoming: frontend uploads, api/v1/router.py --- {multipart file, json}
Processing: docling_health(), docling_convert() / DoclingService.process_base64 --- {3 jobs: JOB_FILE_READ, JOB_TRANSFORM_DATA, JOB_HEALTH_CHECK}
Outgoing: JSON responses (content + format + engine metadata) --- {json, Dict[str, Any]}
"""

from __future__ import annotations

import base64
from typing import Any, Dict, Optional

from core.exceptions import DomainException
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel

from api.dependencies import setup_request_context
from core.integrations.providers.docling import docling_health, get_docling_service
from monitoring import get_logger

logger = get_logger(__name__)

router = APIRouter(tags=["document"], prefix="/document")
action_router = APIRouter(tags=["execute"], prefix="/execute")


class DoclingConvertResponse(BaseModel):
    success: bool
    content: Optional[str] = None
    format: Optional[str] = None
    engine_used: Optional[str] = None
    processing_time: Optional[float] = None
    pages_processed: Optional[int] = None
    error: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@router.get("/health", summary="Docling health")
async def get_docling_health(_context: dict = Depends(setup_request_context)) -> Dict[str, Any]:
    result = docling_health()
    # Fail-fast: surface docling unavailability as 503.
    healthy = bool(result.get("healthy") or result.get("status") == "ok")
    if not healthy:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=result)
    return result


@action_router.post(
    "/convert",
    summary="Convert an uploaded document via Docling (OCR included)",
    response_model=DoclingConvertResponse,
    openapi_extra={"is_agent_tool": True})
async def convert_upload(
    _context: dict = Depends(setup_request_context),
    file: UploadFile = File(...),
    output_format: str = Query(default="markdown", description="markdown|doctags|json|text"),
    pipeline: str = Query(default="standard", description="standard|vlm|... (Docling internal)"),
    ocr_engine: Optional[str] = Query(default=None, description="OCR engine (glm-ocr|easyocr|rapidocr|tesseract)"),
) -> DoclingConvertResponse:
    try:
        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty upload")

        # GLM-OCR means use VLM pipeline (inference server vision model)
        # instead of in-process OCR engine. Translate to pipeline selection.
        effective_pipeline = pipeline
        effective_ocr = ocr_engine
        if ocr_engine == "glm-ocr":
            effective_pipeline = "vlm"
            effective_ocr = None  # VLM pipeline doesn't use in-process OCR

        service = get_docling_service()
        payload_b64 = base64.b64encode(raw).decode("utf-8")

        result = await service.process_base64(
            base64_content=payload_b64,
            filename=file.filename or "upload.bin",
            pipeline=effective_pipeline,
            output_format=output_format,
            ocr_engine=effective_ocr,
        )
        if not result.get("success"):
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=result)
        return DoclingConvertResponse(**result)
    except (HTTPException, DomainException):
        raise
    except Exception as exc:
        logger.error("Docling convert failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Docling convert failed: {exc}",
        ) from exc

