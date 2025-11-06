"""
Docling Wrapper Functions - Layer 1 Implementation

High-level wrapper functions for convenient document conversion.

@.architecture
Incoming: core/integrations/providers/docling/service.py, Open Interpreter --- {str file_path, str pipeline, Dict conversion config}
Processing: docling_convert(), docling_health_check(), async_to_sync_wrapper() --- {3 jobs: async_to_sync_conversion, document_conversion, service_wrapping}
Outgoing: Open Interpreter, core/integrations/framework/loader.py --- {Dict[str, Any] converted document, bool health status}
"""

import asyncio
import logging
from typing import Any, Dict, Optional

from .service import get_docling_service

logger = logging.getLogger(__name__)


def docling_convert(
    file_path: str,
    pipeline: str = "standard",
    ocr_engine: Optional[str] = None,
    vlm_model: Optional[str] = None,
    output_format: str = "markdown",
    lm_studio_url: Optional[str] = None,
    lm_studio_model: Optional[str] = None,
    enable_code_enrichment: bool = False,
    enable_formula_enrichment: bool = False,
    enable_picture_classification: bool = False,
    enable_picture_description: bool = False,
    ocr_languages: Optional[str] = None,
) -> Dict[str, Any]:
    """
    High-level synchronous wrapper for document conversion.
    
    Automatically detects best pipeline based on file type:
    - PDF: SmolDocling for high-accuracy OCR
    - Images: InternVL for vision-language analysis
    - Others: Standard pipeline
    
    Args:
        file_path: Path to document file
        pipeline: Pipeline override (smoldocling, internvl, standard)
        ocr_engine: OCR engine (ocrmac, easyocr, rapidocr)
        vlm_model: Vision-language model
        output_format: Output format (markdown, doctags, json)
        lm_studio_url: LM Studio API URL (None = load from settings)
        lm_studio_model: LM Studio model name
        enable_code_enrichment: Enable code block enrichment
        enable_formula_enrichment: Enable formula enrichment
        enable_picture_classification: Enable image classification
        enable_picture_description: Enable image description
        ocr_languages: Comma-separated language codes
        
    Returns:
        Dict with conversion results
    """
    # Get LM Studio URL from settings if not provided
    if lm_studio_url is None:
        try:
            from config.settings import get_settings
            lm_studio_url = f"{get_settings().integrations.lm_studio_url}/chat/completions"
        except Exception:
            lm_studio_url = "http://localhost:1234/v1/chat/completions"
    

    try:
        # Auto-detect pipeline based on file extension
        file_ext = file_path.lower().split('.')[-1]
        
        if pipeline == "standard":
            if file_ext == "pdf":
                pipeline = "smoldocling"
                logger.info(f"Auto-selected SmolDocling pipeline for PDF: {file_path}")
            elif file_ext in ("png", "jpg", "jpeg", "bmp", "tiff"):
                pipeline = "internvl"
                logger.info(f"Auto-selected InternVL pipeline for image: {file_path}")
        
        # Build configuration
        config = {}
        if ocr_engine:
            config["ocr_engine"] = ocr_engine
        if vlm_model:
            config["vlm_model"] = vlm_model
        if lm_studio_model:
            config["lm_studio_model"] = lm_studio_model
        if lm_studio_url:
            config["lm_studio_url"] = lm_studio_url
        if enable_code_enrichment:
            config["enable_code_enrichment"] = "true"
        if enable_formula_enrichment:
            config["enable_formula_enrichment"] = "true"
        if enable_picture_classification:
            config["enable_picture_classification"] = "true"
        if enable_picture_description:
            config["enable_picture_description"] = "true"
        if ocr_languages:
            config["ocr_languages"] = ocr_languages
        
        # Get service and run conversion
        service = get_docling_service()
        
        # Run async operation in sync context
        result = asyncio.run(
            service.process_file(
                file_path=file_path,
                pipeline=pipeline,
                output_format=output_format,
                **config
            )
        )
        
        return result
        
    except Exception as e:
        error_msg = f"docling_convert error: {str(e)}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}


def docling_health() -> Dict[str, Any]:
    """
    Check Docling service health.
    
    Returns:
        Dict with health status
    """
    try:
        service = get_docling_service()
        return service.health_check()
    except Exception as e:
        return {"status": "error", "error": str(e)}

