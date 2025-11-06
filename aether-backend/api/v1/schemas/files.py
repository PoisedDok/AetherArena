"""
File Processing Schemas

Pydantic models for file upload and processing endpoints.

@.architecture
Incoming: api/v1/endpoints/files.py --- {multipart/form-data uploads, file metadata}
Processing: Pydantic validation and serialization --- {2 jobs: data_validation, serialization}
Outgoing: api/v1/endpoints/files.py --- {FileUploadResponse, FileChatRequest, FileChatResponse, DocumentProcessRequest validated models}
"""

from typing import Optional, Dict, Any, List
from datetime import datetime
from pydantic import BaseModel, Field


# =============================================================================
# File Upload Models
# =============================================================================

class FileUploadResponse(BaseModel):
    """Response after file upload."""
    file_id: str
    filename: str
    size_bytes: int
    mime_type: Optional[str] = None
    upload_timestamp: datetime = Field(default_factory=datetime.utcnow)
    storage_path: str
    
    class Config:
        json_schema_extra = {
            "example": {
                "file_id": "file-123456",
                "filename": "document.pdf",
                "size_bytes": 1024000,
                "mime_type": "application/pdf",
                "upload_timestamp": "2024-11-04T12:00:00Z",
                "storage_path": "data/storage/file-123456.pdf"
            }
        }


# =============================================================================
# File Chat Models
# =============================================================================

class FileChatRequest(BaseModel):
    """Request for file chat processing."""
    file_id: Optional[str] = None
    filename: Optional[str] = None
    message: str = Field(..., min_length=1, max_length=5000)
    model: Optional[str] = None
    use_ocr: bool = False
    ocr_engine: Optional[str] = Field(default=None, pattern="^(easyocr|tesseract|docling)$")
    extract_tables: bool = False
    
    class Config:
        json_schema_extra = {
            "example": {
                "file_id": "file-123456",
                "message": "Summarize this document",
                "model": "gpt-4o",
                "use_ocr": True,
                "ocr_engine": "docling",
                "extract_tables": True
            }
        }


class FileChatResponse(BaseModel):
    """Response from file chat processing."""
    request_id: str
    file_id: str
    filename: str
    response: str
    model_used: str
    processing_time_ms: float
    extracted_content: Optional[str] = None
    tables: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "request_id": "req-789",
                "file_id": "file-123456",
                "filename": "document.pdf",
                "response": "This document discusses...",
                "model_used": "gpt-4o",
                "processing_time_ms": 1250.5,
                "extracted_content": "Full document text...",
                "tables": [{"headers": ["A", "B"], "rows": [["1", "2"]]}],
                "metadata": {"pages": 5, "has_images": True}
            }
        }


# =============================================================================
# Document Processing Models
# =============================================================================

class DocumentProcessRequest(BaseModel):
    """Request for document processing."""
    file_id: str
    operations: List[str] = Field(..., description="Operations to perform: extract_text, extract_tables, ocr, summarize")
    options: Optional[Dict[str, Any]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "file_id": "file-123456",
                "operations": ["extract_text", "extract_tables"],
                "options": {"ocr_engine": "docling", "language": "en"}
            }
        }


class DocumentProcessResponse(BaseModel):
    """Response from document processing."""
    file_id: str
    operations_completed: List[str]
    results: Dict[str, Any]
    processing_time_ms: float
    errors: Optional[List[str]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "file_id": "file-123456",
                "operations_completed": ["extract_text", "extract_tables"],
                "results": {
                    "text": "Extracted text...",
                    "tables": [{"headers": [], "rows": []}]
                },
                "processing_time_ms": 850.3,
                "errors": None
            }
        }


# =============================================================================
# File Metadata Models
# =============================================================================

class FileMetadata(BaseModel):
    """File metadata information."""
    file_id: str
    filename: str
    size_bytes: int
    mime_type: Optional[str] = None
    created_at: datetime
    last_accessed: Optional[datetime] = None
    tags: List[str] = Field(default_factory=list)
    custom_metadata: Optional[Dict[str, Any]] = None

