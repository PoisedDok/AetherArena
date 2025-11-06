"""
OCR Backend Registry

Factory and registry for all OCR backends.
Provides unified access to PaddleOCR-VL, Docling VLMs, and other engines.

@.architecture
Incoming: api/v1/endpoints/ocr.py, core/integrations/libraries/ocr/* backends --- {str backend_name, OCRBackend implementations}
Processing: get_backend(), register_backend(), list_backends(), create_backend() --- {4 jobs: backend_discovery, backend_registration, backend_selection, factory_creation}
Outgoing: api/v1/endpoints/ocr.py --- {BaseOCRBackend instance, List[str] available backends, OCRBackendRegistry}
"""

from typing import Dict, Optional
import logging

from .base import BaseOCRBackend, OCRBackendType
from .paddleocr_backend import PaddleOCRBackend
from .docling_backend import DoclingOCRBackend

logger = logging.getLogger(__name__)


class OCRBackendRegistry:
    """
    Registry and factory for OCR backends.
    
    Manages singleton instances of OCR backends.
    """
    
    _backends: Dict[OCRBackendType, BaseOCRBackend] = {}
    _default_backend = OCRBackendType.PADDLEOCR_VL
    
    @classmethod
    def get_backend(
        cls,
        backend_type: OCRBackendType = None,
        **kwargs
    ) -> Optional[BaseOCRBackend]:
        """
        Get or create OCR backend instance.
        
        Args:
            backend_type: Type of backend (None = default)
            **kwargs: Backend-specific initialization args
            
        Returns:
            OCR backend instance or None if unavailable
        """
        if backend_type is None:
            backend_type = cls._default_backend
        
        # Return existing instance if available
        if backend_type in cls._backends:
            return cls._backends[backend_type]
        
        # Create new backend
        try:
            backend = cls._create_backend(backend_type, **kwargs)
            if backend and backend.is_available():
                cls._backends[backend_type] = backend
                logger.info(f"Created OCR backend: {backend_type.value}")
                return backend
            else:
                logger.warning(f"Backend {backend_type.value} not available")
                return None
                
        except Exception as e:
            logger.error(f"Failed to create backend {backend_type.value}: {e}")
            return None
    
    @classmethod
    def _create_backend(
        cls,
        backend_type: OCRBackendType,
        **kwargs
    ) -> Optional[BaseOCRBackend]:
        """Create new backend instance"""
        
        if backend_type == OCRBackendType.PADDLEOCR_VL:
            return PaddleOCRBackend(**kwargs)
        
        elif backend_type in [
            OCRBackendType.DOCLING_SMOLDOCLING,
            OCRBackendType.DOCLING_GRANITE,
            OCRBackendType.DOCLING_PIXTRAL,
            OCRBackendType.DOCLING_PHI4,
            OCRBackendType.DOCLING_QWEN,
            OCRBackendType.DOCLING_GEMMA,
        ]:
            return DoclingOCRBackend(backend_type=backend_type, **kwargs)
        
        else:
            logger.error(f"Unknown backend type: {backend_type}")
            return None
    
    @classmethod
    def list_available_backends(cls) -> Dict[str, Dict[str, any]]:
        """
        List all available backends with their capabilities.
        
        Returns:
            Dict mapping backend name to info dict
        """
        backends_info = {}
        
        for backend_type in OCRBackendType:
            try:
                backend = cls.get_backend(backend_type)
                if backend and backend.is_available():
                    caps = backend.get_capabilities()
                    backends_info[backend_type.value] = {
                        "available": True,
                        "model_loaded": backend.is_model_loaded(),
                        "capabilities": {
                            "pdf": caps.supports_pdf,
                            "images": caps.supports_images,
                            "tables": caps.supports_tables,
                            "formulas": caps.supports_formulas,
                            "charts": caps.supports_charts,
                            "handwriting": caps.supports_handwriting,
                            "languages": caps.languages,
                        },
                        "memory_mb": caps.memory_mb,
                        "requires_gpu": caps.requires_gpu
                    }
                else:
                    backends_info[backend_type.value] = {
                        "available": False,
                        "reason": "Dependencies not installed or service not running"
                    }
            except Exception as e:
                backends_info[backend_type.value] = {
                    "available": False,
                    "reason": str(e)
                }
        
        return backends_info
    
    @classmethod
    def set_default_backend(cls, backend_type: OCRBackendType) -> None:
        """Set default backend"""
        cls._default_backend = backend_type
        logger.info(f"Default OCR backend set to: {backend_type.value}")
    
    @classmethod
    def get_default_backend(cls) -> OCRBackendType:
        """Get default backend type"""
        return cls._default_backend
    
    @classmethod
    def unload_all(cls) -> None:
        """Unload all backends to free resources"""
        for backend_type, backend in cls._backends.items():
            try:
                backend.unload_model()
                logger.info(f"Unloaded backend: {backend_type.value}")
            except Exception as e:
                logger.error(f"Failed to unload {backend_type.value}: {e}")
        
        cls._backends.clear()

