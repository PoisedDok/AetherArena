"""
File Processing Endpoints

Endpoints for file upload and document processing.

@.architecture
Incoming: api/v1/router.py, Frontend (HTTP POST/GET) --- {multipart/form-data file uploads, HTTP requests to /v1/files/upload, /v1/files/process, /v1/files}
Processing: upload_file(), process_file(), list_files() --- {10 jobs: dependency_injection, error_handling, file_validation, http_communication, metadata_extraction, path_validation, recording, sanitization, size_validation, storage_management}
Outgoing: data/storage/local.py, Frontend (HTTP) --- {file storage operations, FileUploadResponse, JSONResponse with file metadata}
"""

import time
import uuid
import aiofiles
from pathlib import Path
from typing import Dict, Any, Optional, List
from fastapi import APIRouter, Depends, File, Form, UploadFile, HTTPException, status, Query
from fastapi.responses import JSONResponse

from api.dependencies import get_settings, setup_request_context
from api.v1.schemas.files import (
    FileUploadResponse,
    FileChatRequest,
    FileChatResponse
)
from config.settings import Settings
from monitoring import get_logger, counter
from security.sanitization import sanitize_filename, validate_file_upload, PathTraversalError, ValidationError

logger = get_logger(__name__)
router = APIRouter(tags=["files"])

# Metrics
file_operations = counter('aether_file_operations_total', 'Total file operations', ['operation', 'status'])


# =============================================================================
# File Upload
# =============================================================================

@router.post(
    "/files/upload",
    response_model=FileUploadResponse,
    summary="Upload file",
    description="Upload a file for processing"
)
async def upload_file(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> FileUploadResponse:
    """
    Upload file for processing.
    
    Supported formats:
    - Documents: PDF, TXT, MD, DOC, DOCX
    - Spreadsheets: XLS, XLSX, CSV
    - Data: JSON, YAML, YML
    - Images: PNG, JPG, JPEG, GIF, WEBP
    """
    try:
        # Validate file
        if not file.filename:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No filename provided"
            )
        
        # Read content
        content = await file.read()
        
        # Comprehensive file validation with sanitization
        try:
            file_info = validate_file_upload(
                filename=file.filename,
                content_bytes=content,
                allowed_extensions=settings.storage.allowed_extensions
            )
            safe_filename = file_info['safe_filename']
            file_ext = file_info['extension']
        except (ValidationError, PathTraversalError) as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"File validation failed: {str(e)}"
            )
        
        # Check file size against settings
        size_mb = len(content) / (1024 * 1024)
        if size_mb > settings.storage.max_upload_size_mb:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File too large. Max size: {settings.storage.max_upload_size_mb}MB"
            )
        
        # Generate file ID and save
        file_id = str(uuid.uuid4())
        storage_path = settings.storage.base_path / f"{file_id}{file_ext}"
        storage_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Use async file I/O to avoid blocking
        try:
            async with aiofiles.open(storage_path, 'wb') as f:
                await f.write(content)
        except Exception as write_error:
            # Cleanup partial file if write fails
            if storage_path.exists():
                storage_path.unlink()
            raise RuntimeError(f"Failed to write file: {write_error}")
        
        file_operations.inc(operation='upload', status='success')
        logger.info(f"Uploaded file: {safe_filename} ({size_mb:.2f}MB) -> {file_id}")
        
        return FileUploadResponse(
            file_id=file_id,
            filename=safe_filename,
            size_bytes=len(content),
            mime_type=file.content_type or "application/octet-stream",
            storage_path=f"{file_id}{file_ext}"  # Don't expose full path
        )
        
    except HTTPException:
        file_operations.inc(operation='upload', status='error')
        raise
    except Exception as e:
        file_operations.inc(operation='upload', status='error')
        logger.error(f"File upload failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="File upload failed"
        )


# =============================================================================
# File Chat
# =============================================================================

@router.post(
    "/files/process/{file_id}",
    summary="Process file",
    description="Process a previously uploaded file with AI"
)
async def process_file(
    file_id: str,
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    Process previously uploaded file.
    
    Analyzes file metadata and prepares it for AI processing.
    """
    start_time = time.time()
    
    try:
        # Validate file_id to prevent path traversal
        if not file_id or not file_id.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="File ID is required"
            )
        
        # Sanitize file_id - should be UUID format
        file_id = file_id.strip()
        try:
            uuid.UUID(file_id)  # Validate UUID format
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid file ID format"
            )
        
        # Find file in storage (now safe after UUID validation)
        found_file = None
        for file_path in settings.storage.base_path.glob(f"{file_id}.*"):
            if file_path.is_file():
                found_file = file_path
                break
        
        if not found_file:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"File {file_id} not found"
            )
        
        # Get file info
        file_size = found_file.stat().st_size
        filename = found_file.name
        
        duration_ms = (time.time() - start_time) * 1000
        
        file_operations.inc(operation='process', status='success')
        logger.info(f"File processed: {filename} in {duration_ms:.2f}ms")
        
        return JSONResponse({
            "status": "ok",
            "file_id": file_id,
            "filename": filename,
            "size_bytes": file_size,
            "processing_time_ms": duration_ms,
            "message": f"File {filename} processed successfully"
        })
        
    except HTTPException:
        file_operations.inc(operation='process', status='error')
        raise
    except Exception as e:
        file_operations.inc(operation='process', status='error')
        logger.error(f"File processing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="File processing failed"
        )


# =============================================================================
# File Chat (JSON Request)
# =============================================================================

@router.get(
    "/files",
    summary="List files",
    description="List all uploaded files with pagination"
)
async def list_files(
    limit: int = Query(default=100, ge=1, le=1000, description="Maximum files to return"),
    offset: int = Query(default=0, ge=0, description="Number of files to skip"),
    settings: Settings = Depends(get_settings),
    _context: dict = Depends(setup_request_context)
) -> JSONResponse:
    """
    List all uploaded files with pagination.
    
    Returns list of files in storage with metadata.
    Includes pagination to prevent DoS with large file lists.
    """
    try:
        files: List[Dict[str, Any]] = []
        
        # List files in storage with security filtering
        if settings.storage.base_path.exists():
            all_files = []
            for file_path in settings.storage.base_path.glob("*"):
                # Security: Only include regular files, skip hidden files and directories
                if file_path.is_file() and not file_path.name.startswith('.'):
                    try:
                        stat = file_path.stat()
                        # Extract file_id from filename (before extension)
                        file_id_from_name = file_path.stem
                        
                        # Validate UUID format to prevent exposing non-UUID files
                        try:
                            uuid.UUID(file_id_from_name)
                        except ValueError:
                            logger.warning(f"Skipping non-UUID file: {file_path.name}")
                            continue
                        
                        all_files.append({
                            "file_id": file_id_from_name,
                            "filename": file_path.name,
                            "size_bytes": stat.st_size,
                            "created_at": stat.st_ctime
                            # Don't expose full path for security
                        })
                    except Exception as e:
                        logger.warning(f"Error reading file {file_path.name}: {e}")
                        continue
            
            # Sort by creation time (newest first)
            all_files.sort(key=lambda x: x['created_at'], reverse=True)
            
            # Apply pagination
            total_count = len(all_files)
            files = all_files[offset:offset + limit]
        else:
            total_count = 0
        
        logger.info(f"Listed {len(files)} files (offset={offset}, limit={limit}, total={total_count})")
        
        return JSONResponse({
            "files": files,
            "count": len(files),
            "total": total_count,
            "offset": offset,
            "limit": limit
        })
        
    except Exception as e:
        logger.error(f"File listing failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="File listing failed"
        )

