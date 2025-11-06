"""
OCR API Endpoints

Provides document OCR capabilities using multiple backends:
- PaddleOCR-VL (0.9B, efficient, local)
- Chandra (16GB, high accuracy)
- Docling (via service)

Converts images and PDFs to Markdown, HTML, or JSON.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP GET/POST), Uploaded files --- {HTTP requests to /v1/ocr/*, OCRRequest, ModelLoadRequest JSON payloads, multipart/form-data file uploads}
Processing: list_backends(), ocr_health(), load_ocr_model(), unload_ocr_model(), process_file(), process_upload(), get_formats() --- {11 jobs: backend_discovery, data_validation, dependency_injection, document_processing, error_handling, file_validation, format_conversion, health_checking, http_communication, model_lifecycle, path_validation}
Outgoing: core/integrations/libraries/ocr/, Frontend (HTTP) --- {PaddleOCRVLIntegration method calls, OCRHealthResponse, processed document JSON with markdown/html/json}
"""

from typing import Dict, Any, Optional, List
from enum import Enum
from fastapi import APIRouter, Depends, HTTPException, status, File, UploadFile, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from pathlib import Path
import tempfile
import os

from api.dependencies import setup_request_context
from monitoring import get_logger
from security.sanitization import validate_file_path

logger = get_logger(__name__)
router = APIRouter(tags=["ocr"])

# Security constants
MAX_UPLOAD_SIZE = 50 * 1024 * 1024  # 50MB
ALLOWED_FILE_EXTENSIONS = {'.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.gif', '.webp'}


# =============================================================================
# OCR Backend Selection
# =============================================================================

class OCRBackend(str, Enum):
    """Available OCR backends."""
    PADDLEOCR_VL = "paddleocr_vl"  # PaddleOCR-VL-0.9B (default, efficient)
    DOCLING = "docling"  # Docling service (via API)


# Global OCR backend cache (singleton per backend)
_ocr_backends = {}


def get_ocr_backend(backend: OCRBackend):
    """Get OCR backend integration (singleton)."""
    if backend not in _ocr_backends:
        if backend == OCRBackend.PADDLEOCR_VL:
            from core.integrations.libraries.ocr.paddleocr_vl import PaddleOCRVLIntegration
            _ocr_backends[backend] = PaddleOCRVLIntegration()
        elif backend == OCRBackend.DOCLING:
            # Docling via HTTP API - not a direct integration
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail="Docling backend accessed via /docling API endpoints"
            )
    
    return _ocr_backends[backend]


# =============================================================================
# Schemas
# =============================================================================

class OCRRequest(BaseModel):
    """Request to process document."""
    file_path: str = Field(..., description="Path to document file")
    output_format: str = Field("markdown", description="Output format (markdown, html, json)")
    backend: OCRBackend = Field(OCRBackend.PADDLEOCR_VL, description="OCR backend to use")
    task: Optional[str] = Field("ocr", description="Task type (ocr, table, formula, chart) - PaddleOCR-VL only")
    page_range: Optional[str] = Field(None, description="Page range (e.g., '1-5' or '1,3,5')")
    
    class Config:
        json_schema_extra = {
            "example": {
                "file_path": "/path/to/document.pdf",
                "output_format": "markdown",
                "backend": "paddleocr_vl",
                "task": "ocr",
                "page_range": "1-3"
            }
        }


class OCRHealthResponse(BaseModel):
    """OCR system health status."""
    healthy: bool
    message: str
    model_loaded: bool
    backend: str
    supported_formats: list[str]
    supported_file_types: list[str]


class BackendInfo(BaseModel):
    """Information about an OCR backend."""
    name: str
    description: str
    model_size: str
    available: bool
    features: List[str]


class ModelLoadRequest(BaseModel):
    """Request to load OCR model."""
    backend: OCRBackend = Field(OCRBackend.PADDLEOCR_VL, description="OCR backend to use")
    force_reload: bool = Field(False, description="Force model reload")
    
    class Config:
        json_schema_extra = {
            "example": {
                "backend": "paddleocr_vl",
                "force_reload": False
            }
        }


# =============================================================================
# List Available Backends
# =============================================================================

@router.get(
    "/ocr/backends",
    summary="List OCR backends",
    description="Get list of available OCR backends and their capabilities"
)
async def list_backends(
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    List available OCR backends.
    
    Returns information about each backend's capabilities and availability.
    """
    backends = {}
    
    # PaddleOCR-VL
    try:
        from core.integrations.libraries.ocr.paddleocr_vl import PaddleOCRVLIntegration
        ocr = PaddleOCRVLIntegration()
        backends["paddleocr_vl"] = {
            "name": "PaddleOCR-VL",
            "description": "Compact 0.9B VLM for efficient OCR",
            "model_size": "1.8GB (model) + ~2GB (runtime)",
            "available": ocr.is_available(),
            "features": ["OCR", "Table", "Formula", "Chart", "109 languages"]
        }
    except Exception as e:
        backends["paddleocr_vl"] = {
            "name": "PaddleOCR-VL",
            "description": "Compact 0.9B VLM for efficient OCR",
            "model_size": "1.8GB",
            "available": False,
            "features": [],
            "error": str(e)
        }
    
    # Docling
    backends["docling"] = {
        "name": "Docling",
        "description": "Full document processing service",
        "model_size": "Service-based",
        "available": True,
        "features": ["OCR", "Layout analysis", "SmolDocling", "InternVL", "Multiple engines"],
        "note": "Access via /docling endpoints"
    }
    
    return {
        "backends": backends,
        "default": "paddleocr_vl"
    }


# =============================================================================
# OCR Health Check
# =============================================================================

@router.get(
    "/ocr/health",
    response_model=OCRHealthResponse,
    summary="OCR health check",
    description="Check OCR system health and availability for a specific backend"
)
async def ocr_health(
    backend: OCRBackend = OCRBackend.PADDLEOCR_VL,
    _context: dict = Depends(setup_request_context)
) -> OCRHealthResponse:
    """
    Check OCR health for a specific backend.
    
    Returns health status and capabilities.
    """
    try:
        ocr = get_ocr_backend(backend)
        health_data = await ocr.check_health()
        
        return OCRHealthResponse(
            backend=backend.value,
            **health_data
        )
        
    except Exception as e:
        logger.error(f"Health check failed for {backend}: {e}", exc_info=True)
        return OCRHealthResponse(
            healthy=False,
            message=f"Health check failed: {str(e)}",
            model_loaded=False,
            backend=backend.value,
            supported_formats=[],
            supported_file_types=[]
        )


# =============================================================================
# Load OCR Model
# =============================================================================

@router.post(
    "/ocr/load",
    summary="Load OCR model",
    description="Load OCR model into memory (required before processing)"
)
async def load_ocr_model(
    request: ModelLoadRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Load OCR model for a specific backend.
    
    Must be called before processing documents.
    """
    try:
        ocr = get_ocr_backend(request.backend)
        
        if not ocr.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OCR backend '{request.backend}' not available"
            )
        
        success = ocr.load_model(force_reload=request.force_reload)
        
        if not success:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to load {request.backend} model"
            )
        
        logger.info(f"Loaded {request.backend} OCR model")
        
        return {
            "success": True,
            "backend": request.backend.value,
            "message": f"{request.backend.value} model loaded successfully"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Model loading failed for {request.backend}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Model loading failed"
        )


# =============================================================================
# Unload OCR Model
# =============================================================================

@router.post(
    "/ocr/unload",
    summary="Unload OCR model",
    description="Unload OCR model from memory to free resources"
)
async def unload_ocr_model(
    backend: OCRBackend = OCRBackend.PADDLEOCR_VL,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Unload OCR model from memory for a specific backend.
    
    Frees GPU/CPU/MPS resources.
    """
    try:
        ocr = get_ocr_backend(backend)
        ocr.unload_model()
        
        logger.info(f"Unloaded {backend} OCR model")
        
        return {
            "success": True,
            "backend": backend.value,
            "message": f"{backend.value} model unloaded successfully"
        }
        
    except Exception as e:
        logger.error(f"Model unloading failed for {backend}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Model unloading failed"
        )


# =============================================================================
# Process Document File
# =============================================================================

@router.post(
    "/ocr/process/file",
    summary="Process document file",
    description="Process PDF or image file with OCR using selected backend"
)
async def process_file(
    request: OCRRequest,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Process document file with selected OCR backend.
    
    Supports PDF and various image formats.
    Backend options: paddleocr_vl (default), chandra, docling
    """
    try:
        ocr = get_ocr_backend(request.backend)
        
        if not ocr.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OCR backend '{request.backend}' not available"
            )
        
        if not ocr.is_model_loaded():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{request.backend} model not loaded. Call /ocr/load first."
            )
        
        # Validate and sanitize file path
        try:
            validated_path = validate_file_path(request.file_path)
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid file path: {str(e)}"
            )
        
        # Validate file exists
        if not Path(validated_path).exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File not found: {validated_path}"
            )
        
        # Validate file extension
        file_ext = Path(validated_path).suffix.lower()
        if file_ext not in ALLOWED_FILE_EXTENSIONS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported file type: {file_ext}. Allowed: {', '.join(ALLOWED_FILE_EXTENSIONS)}"
            )
        
        # Process file with backend-specific parameters
        if request.backend == OCRBackend.PADDLEOCR_VL:
            result = ocr.process_file(
                file_path=validated_path,
                output_format=request.output_format,
                task=request.task or "ocr"
            )
        else:
            # Other backends may not support task parameter
            result = ocr.process_file(
                file_path=validated_path,
                output_format=request.output_format
            )
        
        if result is None:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"OCR processing failed with {request.backend}"
            )
        
        # Add backend info to result
        result["backend"] = request.backend.value
        
        logger.info(f"Processed {validated_path} with {request.backend} ({result.get('num_pages', 1)} pages)")
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File processing failed with {request.backend}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Processing failed"
        )


# =============================================================================
# Process Uploaded File
# =============================================================================

@router.post(
    "/ocr/process/upload",
    summary="Process uploaded document",
    description="Upload and process document with OCR using selected backend"
)
async def process_upload(
    file: UploadFile = File(..., description="Document file to process"),
    output_format: str = Form("markdown", description="Output format"),
    backend: str = Form("paddleocr_vl", description="OCR backend (paddleocr_vl only)"),
    task: str = Form("ocr", description="Task type (ocr, table, formula, chart) - PaddleOCR-VL only"),
    page_range: Optional[str] = Form(None, description="Page range for PDFs"),
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Process uploaded document with selected OCR backend.
    
    Accepts file upload and returns OCR results.
    """
    try:
        # Validate file size
        content = await file.read()
        await file.seek(0)  # Reset for later read
        
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File too large. Maximum size: {MAX_UPLOAD_SIZE / (1024*1024)}MB"
            )
        
        # Validate file extension
        if file.filename:
            file_ext = Path(file.filename).suffix.lower()
            if file_ext not in ALLOWED_FILE_EXTENSIONS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Unsupported file type: {file_ext}. Allowed: {', '.join(ALLOWED_FILE_EXTENSIONS)}"
                )
        
        # Parse backend
        try:
            backend_enum = OCRBackend(backend)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid backend: {backend}. Choose from: paddleocr_vl, chandra"
            )
        
        ocr = get_ocr_backend(backend_enum)
        
        if not ocr.is_available():
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OCR backend '{backend}' not available"
            )
        
        if not ocr.is_model_loaded():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"{backend} model not loaded. Call /ocr/load first."
            )
        
        # Save uploaded file to temp location
        suffix = Path(file.filename).suffix if file.filename else ".tmp"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        
        try:
            # Process file with backend-specific parameters
            if backend_enum == OCRBackend.PADDLEOCR_VL:
                result = ocr.process_file(
                    file_path=tmp_path,
                    output_format=output_format,
                    task=task
                )
            else:
                result = ocr.process_file(
                    file_path=tmp_path,
                    output_format=output_format
                )
            
            if result is None:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"OCR processing failed with {backend}"
                )
            
            # Add metadata to result
            result["original_filename"] = file.filename
            result["backend"] = backend
            
            logger.info(f"Processed uploaded file {file.filename} with {backend} ({result.get('num_pages', 1)} pages)")
            
            return result
            
        finally:
            # Clean up temp file
            os.unlink(tmp_path)
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Upload processing failed with {backend}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Processing failed"
        )


# =============================================================================
# Get Supported Formats
# =============================================================================

@router.get(
    "/ocr/formats",
    summary="Get supported formats",
    description="Get list of supported input and output formats for a backend"
)
async def get_formats(
    backend: OCRBackend = OCRBackend.PADDLEOCR_VL,
    _context: dict = Depends(setup_request_context)
) -> Dict[str, Any]:
    """
    Get supported formats for a specific OCR backend.
    
    Returns lists of supported input and output formats.
    """
    try:
        ocr = get_ocr_backend(backend)
        
        return {
            "backend": backend.value,
            "input_formats": ocr.get_supported_file_types() if ocr.is_available() else [],
            "output_formats": ocr.get_supported_formats() if ocr.is_available() else []
        }
        
    except Exception as e:
        logger.error(f"Failed to get formats for {backend}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get formats"
        )


