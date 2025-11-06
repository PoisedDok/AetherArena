"""
Docling Service Integration - Layer 1 Implementation

Provides async document conversion via Docling API with SmolDocling/InternVL support.

Features:
- Async HTTP client for document conversion
- Support for file paths and base64 content
- Pipeline configuration (SmolDocling, InternVL, Standard)
- Health checking
- Session management

Production-ready with:
- Connection pooling
- Timeout management
- Error handling
- Resource cleanup
- Configurable URL (from settings)

Note: api_url defaults to None and is loaded from settings.
Override by passing explicit URL for testing/custom deployments.

@.architecture
Incoming: api/v1/endpoints/ocr.py, services/docling --- {str file_path, str base64_content, str pipeline_name, Dict config}
Processing: convert_document(), convert_from_file(), convert_from_base64(), health_check() --- {4 jobs: document_conversion, health_checking, http_communication, pipeline_configuration}
Outgoing: api/v1/endpoints/ocr.py --- {Dict[str, Any] document data with markdown/json/html, bool health status}
"""

import base64
import logging
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)


def _get_docling_url() -> str:
    """Get Docling URL from settings or use default."""
    try:
        from config.settings import get_settings
        return get_settings().integrations.docling_url
    except Exception:
        return "http://localhost:8000"


class DoclingService:
    """
    Async wrapper for Docling API server.
    
    Provides document processing via Docling API with advanced pipelines:
    - SmolDocling: High-accuracy OCR for PDFs
    - InternVL: Vision-language model for images
    - Standard: General document processing
    """
    
    def __init__(self, api_url: Optional[str] = None):
        """
        Initialize Docling service client.
        
        Args:
            api_url: Docling API base URL (None = load from settings)
        """
        if api_url is None:
            api_url = _get_docling_url()
        
        self.api_url = api_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None
        logger.debug(f"Initialized DoclingService with URL: {self.api_url}")
    
    async def initialize(self) -> None:
        """Initialize async HTTP client with connection pooling."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(timeout=120.0, connect=10.0),
                limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
            )
            logger.debug("Docling HTTP client initialized")
    
    async def close(self) -> None:
        """Close async HTTP client and cleanup resources."""
        if self._client:
            await self._client.aclose()
            self._client = None
            logger.debug("Docling HTTP client closed")
    
    async def process_file(
        self,
        file_path: str,
        pipeline: str = "standard",
        ocr_engine: Optional[str] = None,
        vlm_model: Optional[str] = None,
        output_format: str = "markdown",
        **kwargs
    ) -> Dict[str, Any]:
        """
        Process a document from filesystem path.
        
        Args:
            file_path: Path to document file
            pipeline: Pipeline type (smoldocling, internvl, standard)
            ocr_engine: OCR engine override
            vlm_model: VLM model override
            output_format: Output format (markdown, doctags, json)
            **kwargs: Additional pipeline configuration
            
        Returns:
            Dict with:
                - success: bool
                - content: str (converted content)
                - format: str
                - engine_used: str
                - processing_time: float
                - pages_processed: int
                - file_info: dict
                - error: str (if failed)
        """
        await self.initialize()
        
        try:
            path = Path(file_path)
            if not path.exists():
                return {"success": False, "error": f"File not found: {file_path}"}
            
            # Prepare multipart form data
            files = {"file": (path.name, open(path, "rb"), "application/octet-stream")}
            data = {
                "pipeline": pipeline,
                "output_format": output_format
            }
            
            # Add optional parameters
            if ocr_engine:
                data["ocr_engine"] = ocr_engine
            if vlm_model:
                data["vlm_model"] = vlm_model
            
            # Add any additional kwargs
            for key, value in kwargs.items():
                if value is not None:
                    data[key] = str(value)
            
            # Make request
            response = await self._client.post(
                f"{self.api_url}/convert",
                files=files,
                data=data
            )
            
            if response.status_code == 200:
                result = response.json()
                logger.info(f"Successfully processed {path.name} using {pipeline} pipeline")
                return {
                    "success": True,
                    "content": result.get("content", result.get("markdown", "")),
                    "format": result.get("format", output_format),
                    "engine_used": result.get("engine_used", pipeline),
                    "processing_time": result.get("processing_time", 0),
                    "pages_processed": result.get("pages_processed", 1),
                    "file_info": result.get("file_info", {}),
                }
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                logger.error(f"Docling conversion failed: {error_msg}")
                return {"success": False, "error": error_msg}
                
        except httpx.TimeoutException:
            error_msg = "Document processing timed out"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
        except httpx.ConnectError:
            error_msg = f"Cannot connect to Docling at {self.api_url}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
        except Exception as e:
            error_msg = f"Processing error: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    async def process_base64(
        self,
        base64_content: str,
        filename: str,
        pipeline: str = "standard",
        output_format: str = "markdown",
        **kwargs
    ) -> Dict[str, Any]:
        """
        Process a document from base64-encoded content.
        
        Args:
            base64_content: Base64-encoded file content
            filename: Original filename
            pipeline: Pipeline type
            output_format: Output format
            **kwargs: Additional pipeline configuration
            
        Returns:
            Dict with processing results
        """
        await self.initialize()
        
        try:
            # Decode base64 to bytes
            file_bytes = base64.b64decode(base64_content)
            
            # Prepare multipart form data
            files = {"file": (filename, file_bytes, "application/octet-stream")}
            data = {
                "pipeline": pipeline,
                "output_format": output_format
            }
            
            # Add additional kwargs
            for key, value in kwargs.items():
                if value is not None:
                    data[key] = str(value)
            
            # Make request
            response = await self._client.post(
                f"{self.api_url}/convert",
                files=files,
                data=data
            )
            
            if response.status_code == 200:
                result = response.json()
                logger.info(f"Successfully processed base64 content as {filename}")
                return {
                    "success": True,
                    "content": result.get("content", result.get("markdown", "")),
                    "format": result.get("format", output_format),
                    "engine_used": result.get("engine_used", pipeline),
                    "processing_time": result.get("processing_time", 0),
                    "pages_processed": result.get("pages_processed", 1),
                    "file_info": result.get("file_info", {}),
                }
            else:
                error_msg = f"HTTP {response.status_code}: {response.text}"
                logger.error(f"Docling conversion failed: {error_msg}")
                return {"success": False, "error": error_msg}
                
        except Exception as e:
            error_msg = f"Processing error: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def health_check(self) -> Dict[str, Any]:
        """
        Check Docling service health (synchronous).
        
        Returns:
            Dict with:
                - status: str (active, error)
                - url: str
                - error: str (if failed)
        """
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.get(f"{self.api_url}/health")
                if response.status_code == 200:
                    logger.debug("Docling service health check passed")
                    return {
                        "status": "active",
                        "url": self.api_url,
                        "version": response.json().get("version", "unknown")
                    }
                else:
                    error_msg = f"HTTP {response.status_code}"
                    logger.warning(f"Docling health check failed: {error_msg}")
                    return {"status": "error", "error": error_msg}
        except httpx.ConnectError:
            error_msg = f"Cannot connect to {self.api_url}"
            logger.warning(f"Docling health check failed: {error_msg}")
            return {"status": "error", "error": error_msg}
        except Exception as e:
            error_msg = str(e)
            logger.error(f"Docling health check error: {error_msg}")
            return {"status": "error", "error": error_msg}
    
    async def get_supported_formats(self) -> Dict[str, Any]:
        """
        Get supported file formats and pipelines.
        
        Returns:
            Dict with supported formats info
        """
        await self.initialize()
        
        try:
            response = await self._client.get(f"{self.api_url}/formats")
            if response.status_code == 200:
                return response.json()
            else:
                return {"error": f"HTTP {response.status_code}"}
        except Exception as e:
            return {"error": str(e)}


# Singleton instance for shared use
_docling_service: Optional[DoclingService] = None


def get_docling_service(api_url: Optional[str] = None) -> DoclingService:
    """
    Get or create singleton Docling service instance.
    
    Args:
        api_url: Docling API base URL (None = load from settings)
        
    Returns:
        DoclingService instance
    """
    global _docling_service
    
    if _docling_service is None:
        _docling_service = DoclingService(api_url)
        logger.debug("Created singleton DoclingService instance")
    
    return _docling_service

