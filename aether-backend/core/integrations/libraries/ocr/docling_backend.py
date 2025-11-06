"""
Docling OCR Backend Integration

Wraps Docling VLM pipelines for unified OCR interface.
Supports SmolDocling, InternVL, GraniteVision, Pixtral, and other VLMs.

@.architecture
Incoming: core/integrations/libraries/ocr/registry.py, api/v1/endpoints/ocr.py, services/docling --- {bytes document_data, str file_path, str model_name, Dict OCR config}
Processing: process_file(), _load_pipeline(), _process_with_docling() --- {3 jobs: document_processing, inference, pipeline_loading}
Outgoing: core/integrations/libraries/ocr/registry.py, api/v1/endpoints/ocr.py --- {OCRResult with structured document data, OCRCapabilities}
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional
import time

from .base import (
    BaseOCRBackend,
    OCRBackendType,
    OCRCapabilities,
    OCRResult,
    OCRTask
)

try:
    from core.integrations.providers.docling.service import DoclingService, get_docling_service
    DOCLING_AVAILABLE = True
except ImportError:
    DOCLING_AVAILABLE = False


# Map OCR backend types to Docling pipeline names
BACKEND_TO_PIPELINE = {
    OCRBackendType.DOCLING_SMOLDOCLING: "smoldocling",
    OCRBackendType.DOCLING_GRANITE: "granite",
    OCRBackendType.DOCLING_PIXTRAL: "pixtral",
    OCRBackendType.DOCLING_PHI4: "phi4",
    OCRBackendType.DOCLING_QWEN: "qwen",
    OCRBackendType.DOCLING_GEMMA: "gemma",
}


class DoclingOCRBackend(BaseOCRBackend):
    """
    Docling VLM backend for OCR.
    
    Supports multiple VLM pipelines:
    - SmolDocling-256M (fast, compact)
    - GraniteVision-2B (balanced)
    - Pixtral-12B (high accuracy)
    - Phi-4 (Microsoft)
    - Qwen2.5-VL-3B (Alibaba)
    - Gemma-3-12B/27B (Google)
    """
    
    def __init__(
        self,
        backend_type: OCRBackendType = OCRBackendType.DOCLING_SMOLDOCLING,
        service_url: Optional[str] = None
    ):
        """
        Initialize Docling OCR backend.
        
        Args:
            backend_type: Specific Docling VLM backend
            service_url: Docling service URL (None = load from settings)
        """
        super().__init__(backend_type)
        
        if not DOCLING_AVAILABLE:
            self.logger.error("Docling service not available")
            return
        
        self._service = DoclingService(api_url=service_url) if service_url else get_docling_service()
        self._pipeline = BACKEND_TO_PIPELINE.get(backend_type, "smoldocling")
        self._available = DOCLING_AVAILABLE
        self._model_loaded = True  # Service-based, always "loaded" if service is up
        
        self.logger.info(f"Initialized Docling backend: {backend_type.value} (pipeline: {self._pipeline})")
    
    def is_available(self) -> bool:
        """Check if Docling service is available"""
        if not DOCLING_AVAILABLE:
            return False
        
        # Check service health
        health = self._service.health_check()
        return health.get("status") == "active"
    
    def is_model_loaded(self) -> bool:
        """Service-based model is always loaded if service is up"""
        return self.is_available()
    
    def load_model(self, force_reload: bool = False, **kwargs) -> bool:
        """
        Load model (no-op for service-based backend).
        
        Service manages models internally.
        """
        if not DOCLING_AVAILABLE:
            self.logger.error("Docling not available")
            return False
        
        # Verify service is healthy
        return self.is_available()
    
    def unload_model(self) -> None:
        """Unload model (no-op for service-based backend)"""
        self.logger.debug(f"{self.backend_type.value}: service-based, no explicit unload needed")
    
    def process_file(
        self,
        file_path: str,
        task: OCRTask = OCRTask.OCR,
        output_format: str = "markdown",
        **kwargs
    ) -> OCRResult:
        """
        Process document file via Docling service.
        
        Args:
            file_path: Path to document
            task: OCR task type
            output_format: Output format (markdown, doctags, json)
            **kwargs: Additional options (vlm_model, ocr_engine, etc.)
            
        Returns:
            OCRResult with processing results
        """
        if not self.is_available():
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                error="Docling service not available"
            )
        
        try:
            start_time = time.time()
            
            # Run async process_file
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If already in async context, create task
                result = asyncio.create_task(self._service.process_file(
                    file_path=file_path,
                    pipeline=self._pipeline,
                    output_format=output_format,
                    **kwargs
                ))
                # Wait for result
                result = loop.run_until_complete(result)
            else:
                # Create new event loop
                result = asyncio.run(self._service.process_file(
                    file_path=file_path,
                    pipeline=self._pipeline,
                    output_format=output_format,
                    **kwargs
                ))
            
            processing_time = time.time() - start_time
            
            if result.get("success"):
                return OCRResult(
                    success=True,
                    text=result.get("content", ""),
                    markdown=result.get("content", ""),
                    num_pages=result.get("pages_processed", 1),
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=processing_time,
                    metadata={
                        "engine_used": result.get("engine_used"),
                        "format": result.get("format"),
                        "file_info": result.get("file_info", {})
                    }
                )
            else:
                return OCRResult(
                    success=False,
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=processing_time,
                    error=result.get("error", "Unknown error")
                )
                
        except Exception as e:
            self.logger.error(f"Docling processing failed: {e}", exc_info=True)
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                task=task.value,
                error=str(e)
            )
    
    def process_upload(
        self,
        file_data: bytes,
        filename: str,
        task: OCRTask = OCRTask.OCR,
        output_format: str = "markdown",
        **kwargs
    ) -> OCRResult:
        """
        Process uploaded file data via Docling service.
        
        Args:
            file_data: File binary data
            filename: Original filename
            task: OCR task type
            output_format: Output format
            **kwargs: Additional options
            
        Returns:
            OCRResult with processing results
        """
        if not self.is_available():
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                error="Docling service not available"
            )
        
        # Save to temp file and process
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=Path(filename).suffix) as tmp:
                tmp.write(file_data)
                tmp_path = tmp.name
            
            result = self.process_file(
                file_path=tmp_path,
                task=task,
                output_format=output_format,
                **kwargs
            )
            
            # Cleanup temp file
            Path(tmp_path).unlink(missing_ok=True)
            
            return result
            
        except Exception as e:
            self.logger.error(f"Upload processing failed: {e}", exc_info=True)
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                task=task.value,
                error=str(e)
            )
    
    def get_capabilities(self) -> OCRCapabilities:
        """Get Docling backend capabilities"""
        # VLM models support comprehensive document understanding
        return OCRCapabilities(
            supports_pdf=True,
            supports_images=True,
            supports_tables=True,
            supports_formulas=True,
            supports_charts=True,
            supports_handwriting=True,
            supports_multilang=True,
            languages=["en", "multilingual"],  # VLMs support many languages
            max_file_size_mb=200,
            requires_gpu=False,  # Service handles GPU
            memory_mb=0  # External service
        )
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check Docling service health.
        
        Returns:
            Dict with health status
        """
        if not DOCLING_AVAILABLE:
            return {
                "healthy": False,
                "message": "Docling service module not available",
                "model_loaded": False,
                "backend": self.backend_type.value
            }
        
        health = self._service.health_check()
        
        return {
            "healthy": health.get("status") == "active",
            "message": f"Docling {self._pipeline} pipeline",
            "model_loaded": health.get("status") == "active",
            "backend": self.backend_type.value,
            "supported_formats": self.get_supported_formats()["input_formats"],
            "supported_file_types": self.get_supported_formats()["input_formats"],
            "service_url": health.get("url", "unknown")
        }

