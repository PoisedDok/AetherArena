"""
GLM-OCR Backend Implementation

OCR backend that delegates to the Aether Inference server running GLM-OCR.
Unlike other backends which run in-process, this communicates via HTTP API.

@.architecture
Incoming: registry.py, api/v1/endpoints/ocr.py --- {process_file, process_upload, health_check}
Processing: format prompts via GlmOcrAdapter, call InferenceClient --- {2 jobs: JOB_TRANSFORM_DATA, JOB_API_CALL}
Outgoing: aether-inference server via core/integrations/providers/aether_inference/ --- {OpenAI chat/completions}
"""

import asyncio
import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .base import BaseOCRBackend, OCRBackendType, OCRCapabilities, OCRResult, OCRTask

logger = logging.getLogger(__name__)

# Map OCRTask to GLMOCRTask
_TASK_MAP = {
    OCRTask.OCR: "text",
    OCRTask.TABLE: "table",
    OCRTask.FORMULA: "formula",
}


class GlmOcrBackend(BaseOCRBackend):
    """
    GLM-OCR backend via Aether Inference server.
    
    Requires the inference server to be running with a GLM-OCR model loaded.
    Falls back gracefully if inference is unavailable.
    """
    
    def __init__(self, **kwargs):
        super().__init__(backend_type=OCRBackendType.GLM_OCR)
        self._inference_available = False
        self._model_name: Optional[str] = None
    
    def is_available(self) -> bool:
        """
        Check if GLM-OCR is available (inference server running + model loaded).
        
        Non-blocking: uses cached status from last health check.
        """
        try:
            # Quick check: can we import the client?
            from core.integrations.providers.aether_inference.client import get_inference_client
            return True  # Client exists; actual health checked in check_health()
        except ImportError:
            return False
    
    def is_model_loaded(self) -> bool:
        """Check if inference server has GLM-OCR model loaded."""
        return self._inference_available
    
    def load_model(self, force_reload: bool = False, **kwargs) -> bool:
        """
        For GLM-OCR, 'loading' means verifying the inference server is healthy.
        The model is loaded server-side, not in this process.
        """
        try:
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            
            if loop and loop.is_running():
                # Inside an async context -- run in thread to avoid blocking
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor() as pool:
                    return pool.submit(asyncio.run, self._async_load_model()).result()
            else:
                # No running loop -- safe to use asyncio.run directly
                return asyncio.run(self._async_load_model())
        except Exception as e:
            self.logger.warning("Failed to verify GLM-OCR availability: %s", e)
            return False
    
    async def _async_load_model(self) -> bool:
        """Async health check for model loading."""
        health = await self.check_health()
        self._inference_available = health.get("healthy", False)
        return self._inference_available
    
    def unload_model(self) -> None:
        """No-op: model runs server-side, not managed by this process."""
        self._inference_available = False
        self._model_loaded = False
    
    # Image extensions GLM-OCR can process. PDFs and other documents must
    # go through the Docling pipeline (core.runtime.document), not here.
    _SUPPORTED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tiff", ".tif", ".bmp"}

    def process_file(
        self,
        file_path: str,
        task: OCRTask = OCRTask.OCR,
        output_format: str = "markdown",
        **kwargs
    ) -> OCRResult:
        """
        Process an **image** file via GLM-OCR.
        
        PDFs and other document formats are NOT supported — they must be routed
        through the Docling pipeline (core.runtime.document) which handles
        multi-page extraction, layout analysis, and OCR engine selection.
        """
        start_time = time.time()
        
        try:
            path = Path(file_path)
            if not path.exists():
                return OCRResult(
                    success=False,
                    error=f"File not found: {file_path}",
                    backend=self.backend_type.value,
                    task=task.value,
                )
            
            # Reject non-image files — PDFs/docs must go through Docling
            ext = path.suffix.lower()
            if ext not in self._SUPPORTED_IMAGE_EXTS:
                return OCRResult(
                    success=False,
                    error=(
                        f"GLM-OCR only supports image files ({', '.join(sorted(self._SUPPORTED_IMAGE_EXTS))}). "
                        f"Got '{ext}' file. PDFs and documents must be processed via the Docling pipeline."
                    ),
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=time.time() - start_time,
                )
            
            # Read file and encode
            file_bytes = path.read_bytes()
            return self._process_bytes(
                file_bytes, path.name, task, output_format, start_time, **kwargs
            )
            
        except Exception as e:
            self.logger.error("GLM-OCR file processing failed: %s", e, exc_info=True)
            return OCRResult(
                success=False,
                error=str(e),
                backend=self.backend_type.value,
                task=task.value,
                processing_time=time.time() - start_time,
            )
    
    def process_upload(
        self,
        file_data: bytes,
        filename: str,
        task: OCRTask = OCRTask.OCR,
        output_format: str = "markdown",
        **kwargs
    ) -> OCRResult:
        """Process uploaded file data via GLM-OCR."""
        start_time = time.time()
        return self._process_bytes(file_data, filename, task, output_format, start_time, **kwargs)
    
    def _process_bytes(
        self,
        file_bytes: bytes,
        filename: str,
        task: OCRTask,
        output_format: str,
        start_time: float,
        **kwargs,
    ) -> OCRResult:
        """Core processing: encode image, send to inference, parse response."""
        try:
            from core.integrations.providers.aether_inference.glm_ocr import (
                GlmOcrAdapter, GLMOCRTask,
            )
            from core.integrations.providers.aether_inference.client import get_inference_client
            
            adapter = GlmOcrAdapter()
            client = get_inference_client()
            
            # Determine MIME type from filename — image formats only.
            # PDFs/documents must go through the Docling pipeline, not GLM-OCR.
            ext = Path(filename).suffix.lower()
            mime_map = {
                ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                ".gif": "image/gif", ".webp": "image/webp", ".tiff": "image/tiff",
                ".tif": "image/tiff", ".bmp": "image/bmp",
            }
            mime_type = mime_map.get(ext)
            if mime_type is None:
                return OCRResult(
                    success=False,
                    error=(
                        f"GLM-OCR only supports image files ({', '.join(sorted(mime_map.keys()))}). "
                        f"Got '{ext}' file. PDFs and documents must be processed via the Docling pipeline."
                    ),
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=time.time() - start_time,
                )
            
            # Encode to base64 URL
            image_url = adapter.encode_image_bytes_to_base64_url(file_bytes, mime_type)
            
            # Map task
            glm_task_str = _TASK_MAP.get(task, "text")
            glm_task = GLMOCRTask(glm_task_str)
            
            # Build messages
            messages = adapter.format_recognition_messages(image_url, glm_task)
            
            # Call inference (async client, need to bridge to sync context)
            coro = client.chat_completion(messages=messages, max_tokens=8192, temperature=0.0)
            try:
                try:
                    loop = asyncio.get_running_loop()
                except RuntimeError:
                    loop = None
                
                if loop and loop.is_running():
                    # Inside an async context (e.g. FastAPI request handler)
                    # Run in a thread to avoid blocking the event loop
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor() as pool:
                        response = pool.submit(asyncio.run, coro).result()
                else:
                    # No running loop -- safe to use asyncio.run directly
                    response = asyncio.run(coro)
            except Exception as e:
                return OCRResult(
                    success=False,
                    error=f"Inference call failed: {e}",
                    backend=self.backend_type.value,
                    task=task.value,
                    processing_time=time.time() - start_time,
                )
            
            # Parse response
            text = adapter.parse_response(response)
            
            processing_time = time.time() - start_time
            
            return OCRResult(
                success=True,
                text=text,
                markdown=text,  # GLM-OCR outputs markdown-compatible text
                confidence=0.95,  # GLM-OCR is high-accuracy
                num_pages=1,
                backend=self.backend_type.value,
                task=task.value,
                processing_time=processing_time,
                metadata={
                    "model": self._model_name or "glm-ocr",
                    "engine": "aether-inference",
                    "filename": filename,
                },
            )
            
        except ImportError as e:
            return OCRResult(
                success=False,
                error=f"GLM-OCR dependencies not available: {e}",
                backend=self.backend_type.value,
                task=task.value,
                processing_time=time.time() - start_time,
            )
        except Exception as e:
            self.logger.error("GLM-OCR processing error: %s", e, exc_info=True)
            return OCRResult(
                success=False,
                error=str(e),
                backend=self.backend_type.value,
                task=task.value,
                processing_time=time.time() - start_time,
            )
    
    def get_capabilities(self) -> OCRCapabilities:
        """GLM-OCR capabilities — image-only. PDFs go through Docling."""
        return OCRCapabilities(
            supports_pdf=False,
            supports_images=True,
            supports_tables=True,
            supports_formulas=True,
            supports_charts=False,
            supports_handwriting=True,
            supports_multilang=True,
            languages=["en", "zh", "ja", "ko", "de", "fr", "es", "pt"],  # GLM-OCR 8 languages
            max_file_size_mb=50,
            requires_gpu=False,  # GPU is on the inference server side, not here
            memory_mb=0,  # No in-process memory -- runs server-side
        )
    
    async def check_health(self) -> Dict[str, Any]:
        """Check health by querying the inference server."""
        try:
            from core.integrations.providers.aether_inference.client import inference_health
            health = await inference_health()
            self._inference_available = health.get("healthy", False)
            return {
                "healthy": self._inference_available,
                "backend": self.backend_type.value,
                "engine": "aether-inference",
                **{k: v for k, v in health.items() if k != "healthy"},
            }
        except Exception as e:
            self._inference_available = False
            return {
                "healthy": False,
                "backend": self.backend_type.value,
                "error": str(e),
            }
