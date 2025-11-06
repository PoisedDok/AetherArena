"""
OCR Backend Base Classes

Unified abstraction for all OCR backends following Aether's integration framework.
Supports PaddleOCR-VL, Docling VLMs (SmolDocling, InternVL, etc.), and other engines.

@.architecture
Incoming: core/integrations/libraries/ocr/paddleocr_backend.py, core/integrations/libraries/ocr/docling_backend.py, core/integrations/libraries/ocr/registry.py --- {OCR backend implementations}
Processing: OCRBackend abstract methods, process_file(), process_image(), get_capabilities() --- {4 jobs: abstraction, capability_management, ocr_orchestration, result_formatting}
Outgoing: api/v1/endpoints/ocr.py, OCR backend implementations --- {OCRResult, OCRCapabilities, Dict[str, Any] OCR output}
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)


class OCRBackendType(str, Enum):
    """OCR backend types"""
    PADDLEOCR_VL = "paddleocr_vl"
    DOCLING_SMOLDOCLING = "docling_smoldocling"
    DOCLING_GRANITE = "docling_granite"
    DOCLING_PIXTRAL = "docling_pixtral"
    DOCLING_PHI4 = "docling_phi4"
    DOCLING_QWEN = "docling_qwen"
    DOCLING_GEMMA = "docling_gemma"
    RAPIDOCR = "rapidocr"
    TESSERACT = "tesseract"


class OCRTask(str, Enum):
    """OCR task types"""
    OCR = "ocr"  # General text recognition
    TABLE = "table"  # Table extraction
    FORMULA = "formula"  # Formula recognition
    CHART = "chart"  # Chart recognition
    LAYOUT = "layout"  # Document layout analysis


@dataclass
class OCRCapabilities:
    """OCR backend capabilities"""
    supports_pdf: bool = True
    supports_images: bool = True
    supports_tables: bool = False
    supports_formulas: bool = False
    supports_charts: bool = False
    supports_handwriting: bool = False
    supports_multilang: bool = False
    languages: List[str] = field(default_factory=lambda: ["en"])
    max_file_size_mb: int = 100
    requires_gpu: bool = False
    memory_mb: int = 0  # Approx memory usage


@dataclass
class OCRResult:
    """Unified OCR result structure"""
    success: bool
    text: str = ""
    markdown: str = ""
    confidence: float = 0.0
    num_pages: int = 1
    backend: str = ""
    task: str = "ocr"
    processing_time: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class BaseOCRBackend(ABC):
    """
    Abstract base for all OCR backends.
    
    Provides unified interface following Aether's integration patterns.
    Subclasses implement specific OCR engines.
    """
    
    def __init__(self, backend_type: OCRBackendType):
        """
        Initialize OCR backend.
        
        Args:
            backend_type: Type of OCR backend
        """
        self.backend_type = backend_type
        self._model_loaded = False
        self._available = False
        self.logger = logging.getLogger(f"ocr.{backend_type.value}")
    
    @abstractmethod
    def is_available(self) -> bool:
        """Check if backend is available (dependencies installed, etc.)"""
        pass
    
    @abstractmethod
    def is_model_loaded(self) -> bool:
        """Check if model is loaded in memory"""
        pass
    
    @abstractmethod
    def load_model(self, force_reload: bool = False, **kwargs) -> bool:
        """
        Load OCR model into memory.
        
        Args:
            force_reload: Force model reload even if already loaded
            **kwargs: Backend-specific options
            
        Returns:
            True if loaded successfully
        """
        pass
    
    @abstractmethod
    def unload_model(self) -> None:
        """Unload model from memory to free resources"""
        pass
    
    @abstractmethod
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
            output_format: Output format (markdown, html, json)
            **kwargs: Backend-specific options
            
        Returns:
            OCRResult with processing results
        """
        pass
    
    @abstractmethod
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
            **kwargs: Backend-specific options
            
        Returns:
            OCRResult with processing results
        """
        pass
    
    @abstractmethod
    def get_capabilities(self) -> OCRCapabilities:
        """Get backend capabilities"""
        pass
    
    @abstractmethod
    async def check_health(self) -> Dict[str, Any]:
        """
        Check backend health.
        
        Returns:
            Dict with health status
        """
        pass
    
    def get_supported_formats(self) -> Dict[str, List[str]]:
        """Get supported input and output formats"""
        caps = self.get_capabilities()
        
        input_formats = []
        if caps.supports_pdf:
            input_formats.append("pdf")
        if caps.supports_images:
            input_formats.extend(["png", "jpg", "jpeg", "bmp", "tiff"])
        
        output_formats = ["markdown", "html", "json", "text"]
        
        return {
            "input_formats": input_formats,
            "output_formats": output_formats
        }

