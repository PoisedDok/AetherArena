"""
OCR Integration - Layer 2 Exposure

Clean exports for unified OCR system following 4-layer architecture.

Provides access to:
- PaddleOCR-VL (0.9B, local, efficient)
- Docling VLMs (SmolDocling, GraniteVision, Pixtral, Phi-4, Qwen, Gemma)
- Unified OCR interface for all backends

Usage:
    from core.integrations.libraries.ocr import ocr_process_file, ocr_list_backends
    
    backends = ocr_list_backends()
    result = ocr_process_file("/path/to/doc.pdf", backend="paddleocr_vl")
"""

from .base import (
    OCRBackendType,
    OCRTask,
    OCRCapabilities,
    OCRResult,
    BaseOCRBackend
)
from .registry import OCRBackendRegistry
from .paddleocr_backend import PaddleOCRBackend
from .docling_backend import DoclingOCRBackend

# High-level API functions
def ocr_process_file(
    file_path: str,
    backend: str = "paddleocr_vl",
    task: str = "ocr",
    output_format: str = "markdown",
    **kwargs
) -> dict:
    """
    Process document file with specified OCR backend.
    
    Args:
        file_path: Path to document
        backend: Backend name (paddleocr_vl, docling_smoldocling, etc.)
        task: Task type (ocr, table, formula, chart)
        output_format: Output format (markdown, html, json)
        **kwargs: Backend-specific options
        
    Returns:
        Dict with OCR results
    """
    try:
        backend_type = OCRBackendType(backend)
    except ValueError:
        return {"success": False, "error": f"Unknown backend: {backend}"}
    
    backend_inst = OCRBackendRegistry.get_backend(backend_type)
    if not backend_inst:
        return {"success": False, "error": f"Backend not available: {backend}"}
    
    try:
        task_enum = OCRTask(task)
    except ValueError:
        return {"success": False, "error": f"Unknown task: {task}"}
    
    result = backend_inst.process_file(
        file_path=file_path,
        task=task_enum,
        output_format=output_format,
        **kwargs
    )
    
    return {
        "success": result.success,
        "text": result.text,
        "markdown": result.markdown,
        "num_pages": result.num_pages,
        "backend": result.backend,
        "task": result.task,
        "processing_time": result.processing_time,
        "metadata": result.metadata,
        "error": result.error
    }


def ocr_process_upload(
    file_data: bytes,
    filename: str,
    backend: str = "paddleocr_vl",
    task: str = "ocr",
    output_format: str = "markdown",
    **kwargs
) -> dict:
    """
    Process uploaded file data with specified OCR backend.
    
    Args:
        file_data: File binary data
        filename: Original filename
        backend: Backend name
        task: Task type
        output_format: Output format
        **kwargs: Backend-specific options
        
    Returns:
        Dict with OCR results
    """
    try:
        backend_type = OCRBackendType(backend)
    except ValueError:
        return {"success": False, "error": f"Unknown backend: {backend}"}
    
    backend_inst = OCRBackendRegistry.get_backend(backend_type)
    if not backend_inst:
        return {"success": False, "error": f"Backend not available: {backend}"}
    
    try:
        task_enum = OCRTask(task)
    except ValueError:
        return {"success": False, "error": f"Unknown task: {task}"}
    
    result = backend_inst.process_upload(
        file_data=file_data,
        filename=filename,
        task=task_enum,
        output_format=output_format,
        **kwargs
    )
    
    return {
        "success": result.success,
        "text": result.text,
        "markdown": result.markdown,
        "num_pages": result.num_pages,
        "backend": result.backend,
        "original_filename": filename,
        "error": result.error
    }


def ocr_list_backends() -> dict:
    """
    List all available OCR backends with capabilities.
    
    Returns:
        Dict mapping backend names to info
    """
    return {
        "backends": OCRBackendRegistry.list_available_backends(),
        "default": OCRBackendRegistry.get_default_backend().value
    }


def ocr_load_model(backend: str, force_reload: bool = False) -> dict:
    """
    Load OCR model for specified backend.
    
    Args:
        backend: Backend name
        force_reload: Force model reload
        
    Returns:
        Dict with load status
    """
    try:
        backend_type = OCRBackendType(backend)
    except ValueError:
        return {"success": False, "error": f"Unknown backend: {backend}"}
    
    backend_inst = OCRBackendRegistry.get_backend(backend_type)
    if not backend_inst:
        return {"success": False, "error": f"Backend not available: {backend}"}
    
    success = backend_inst.load_model(force_reload=force_reload)
    return {
        "success": success,
        "backend": backend,
        "message": f"Model loaded successfully" if success else "Failed to load model"
    }


def ocr_unload_model(backend: str) -> dict:
    """
    Unload OCR model for specified backend.
    
    Args:
        backend: Backend name
        
    Returns:
        Dict with unload status
    """
    try:
        backend_type = OCRBackendType(backend)
    except ValueError:
        return {"success": False, "error": f"Unknown backend: {backend}"}
    
    backend_inst = OCRBackendRegistry.get_backend(backend_type)
    if not backend_inst:
        return {"success": False, "error": f"Backend not found: {backend}"}
    
    backend_inst.unload_model()
    return {
        "success": True,
        "backend": backend,
        "message": "Model unloaded successfully"
    }


def ocr_health_check(backend: str = None) -> dict:
    """
    Check health of OCR backend(s).
    
    Args:
        backend: Backend name (None = check all)
        
    Returns:
        Dict with health status
    """
    import asyncio
    
    if backend:
        try:
            backend_type = OCRBackendType(backend)
        except ValueError:
            return {"healthy": False, "error": f"Unknown backend: {backend}"}
        
        backend_inst = OCRBackendRegistry.get_backend(backend_type)
        if not backend_inst:
            return {"healthy": False, "error": f"Backend not available: {backend}"}
        
        # Run async health check
        try:
            health = asyncio.run(backend_inst.check_health())
            return health
        except Exception as e:
            return {"healthy": False, "error": str(e)}
    
    else:
        # Check all backends
        results = {}
        for backend_type in OCRBackendType:
            backend_inst = OCRBackendRegistry.get_backend(backend_type)
            if backend_inst:
                try:
                    health = asyncio.run(backend_inst.check_health())
                    results[backend_type.value] = health
                except Exception as e:
                    results[backend_type.value] = {"healthy": False, "error": str(e)}
        
        return {"backends": results}


# Export all public functions
__all__ = [
    # Base classes and enums
    "OCRBackendType",
    "OCRTask",
    "OCRCapabilities",
    "OCRResult",
    "BaseOCRBackend",
    # Backend implementations
    "PaddleOCRBackend",
    "DoclingOCRBackend",
    # Registry
    "OCRBackendRegistry",
    # High-level API
    "ocr_process_file",
    "ocr_process_upload",
    "ocr_list_backends",
    "ocr_load_model",
    "ocr_unload_model",
    "ocr_health_check",
]
