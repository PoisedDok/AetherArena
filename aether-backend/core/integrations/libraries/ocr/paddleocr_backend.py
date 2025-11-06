"""
PaddleOCR-VL Backend Wrapper

Wraps existing PaddleOCRVLIntegration with unified OCR interface.

@.architecture
Incoming: core/integrations/libraries/ocr/registry.py, api/v1/endpoints/ocr.py --- {bytes image_data, str file_path, Dict OCR config}
Processing: process_image(), process_file(), _get_integration() --- {3 jobs: image_processing, integration_wrapping, ocr_processing}
Outgoing: core/integrations/libraries/ocr/registry.py, api/v1/endpoints/ocr.py --- {OCRResult with text/layout, OCRCapabilities}
"""

import asyncio
from pathlib import Path
from typing import Any, Dict

from .base import (
    BaseOCRBackend,
    OCRBackendType,
    OCRCapabilities,
    OCRResult,
    OCRTask
)

try:
    from .paddleocr_vl import PaddleOCRVLIntegration
    PADDLEOCR_AVAILABLE = True
except ImportError:
    PADDLEOCR_AVAILABLE = False


class PaddleOCRBackend(BaseOCRBackend):
    """
    PaddleOCR-VL backend wrapper.
    
    Wraps existing PaddleOCRVLIntegration with unified interface.
    """
    
    def __init__(self, model_path: str = None):
        """
        Initialize PaddleOCR-VL backend.
        
        Args:
            model_path: Path to model (None = use default)
        """
        super().__init__(OCRBackendType.PADDLEOCR_VL)
        
        if not PADDLEOCR_AVAILABLE:
            self.logger.error("PaddleOCR-VL not available")
            return
        
        self._ocr = PaddleOCRVLIntegration(model_path=model_path)
        self._available = self._ocr.is_available()
        
        self.logger.info("Initialized PaddleOCR-VL backend")
    
    def is_available(self) -> bool:
        """Check if PaddleOCR-VL is available"""
        return PADDLEOCR_AVAILABLE and self._ocr.is_available()
    
    def is_model_loaded(self) -> bool:
        """Check if model is loaded"""
        return self._available and self._ocr.is_model_loaded()
    
    def load_model(self, force_reload: bool = False, **kwargs) -> bool:
        """
        Load PaddleOCR-VL model.
        
        Args:
            force_reload: Force model reload
            **kwargs: Additional options
            
        Returns:
            True if loaded successfully
        """
        if not self._available:
            return False
        
        return self._ocr.load_model(force_reload=force_reload)
    
    def unload_model(self) -> None:
        """Unload model from memory"""
        if self._available:
            self._ocr.unload_model()
    
    def process_file(
        self,
        file_path: str,
        task: OCRTask = OCRTask.OCR,
        output_format: str = "markdown",
        **kwargs
    ) -> OCRResult:
        """
        Process document file.
        
        Args:
            file_path: Path to document
            task: OCR task type
            output_format: Output format
            **kwargs: Additional options
            
        Returns:
            OCRResult with processing results
        """
        if not self.is_model_loaded():
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                error="Model not loaded. Call load_model() first."
            )
        
        try:
            result = self._ocr.process_file(
                file_path=file_path,
                output_format=output_format,
                task=task.value,
                **kwargs
            )
            
            if result:
                return OCRResult(
                    success=result.get("success", True),
                    text=result.get("text", ""),
                    markdown=result.get("markdown", result.get("text", "")),
                    num_pages=result.get("num_pages", 1),
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=result.get("processing_time", 0),
                    metadata=result.get("metadata", {})
                )
            else:
                return OCRResult(
                    success=False,
                    backend=self.backend_type.value,
                    error="Processing returned None"
                )
                
        except Exception as e:
            self.logger.error(f"Processing failed: {e}", exc_info=True)
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
        Process uploaded file data.
        
        Args:
            file_data: File binary data
            filename: Original filename
            task: OCR task type
            output_format: Output format
            **kwargs: Additional options
            
        Returns:
            OCRResult with processing results
        """
        if not self.is_model_loaded():
            return OCRResult(
                success=False,
                backend=self.backend_type.value,
                error="Model not loaded"
            )
        
        # Save to temp file and process
        import tempfile
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
            
            # Cleanup
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
        """Get PaddleOCR-VL capabilities"""
        return OCRCapabilities(
            supports_pdf=True,
            supports_images=True,
            supports_tables=True,
            supports_formulas=True,
            supports_charts=True,
            supports_handwriting=True,
            supports_multilang=True,
            languages=["en", "zh", "109+ languages"],
            max_file_size_mb=100,
            requires_gpu=False,  # Can run on CPU/MPS
            memory_mb=4000  # ~4GB with optimizations
        )
    
    async def check_health(self) -> Dict[str, Any]:
        """
        Check backend health.
        
        Returns:
            Dict with health status
        """
        return {
            "healthy": self.is_available(),
            "message": "PaddleOCR-VL 0.9B model" if self.is_available() else "Not available",
            "model_loaded": self.is_model_loaded(),
            "backend": self.backend_type.value,
            "supported_formats": self.get_supported_formats()["input_formats"],
            "supported_file_types": self.get_supported_formats()["input_formats"]
        }

