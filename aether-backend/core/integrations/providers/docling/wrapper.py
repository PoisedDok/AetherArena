"""
Docling Wrapper Functions - Layer 1 Implementation

High-level wrapper functions for convenient document conversion.

@.architecture
Incoming: core/integrations/providers/docling/service.py, Open Interpreter --- {str file_path, str pipeline, Dict conversion config}
Processing: docling_convert(), docling_health_check(), async_to_sync_wrapper() --- {JOB_EXECUTE_TOOL, JOB_LOAD_CONFIG, JOB_TRANSFORM_DATA}
Outgoing: Open Interpreter, core/integrations/framework/loader.py --- {Dict[str, Any] converted document, bool health status}
"""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError as ThreadTimeoutError
from typing import Any, Coroutine, Dict, Optional

from .service import get_docling_service

logger = logging.getLogger(__name__)

_EXECUTOR_TIMEOUT_SECONDS = 300  # generous upper bound for heavy OCR workloads


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
    # Resolve defaults from central settings (LLM proxy + vision model)
    settings = None
    if lm_studio_url is None or lm_studio_model is None or vlm_model is None:
        from config.settings import get_settings
        settings = get_settings()

    if lm_studio_url is None:
        base_url = (settings.base_url or "").rstrip("/") if settings else ""
        if not base_url:
            raise RuntimeError("settings.base_url is empty; cannot build LLM proxy URL")
        lm_studio_url = f"{base_url}/v1/llm/chat/completions"

    if lm_studio_model is None and settings is not None:
        lm_studio_model = settings.vision_document.vision_model_lmstudio
    

    try:
        # Auto-detect pipeline based on file extension
        file_ext = file_path.lower().split('.')[-1]
        
        selected_pipeline = pipeline
        selected_vlm_model = vlm_model

        if pipeline == "standard":
            if file_ext == "pdf":
                selected_pipeline = "vlm"
                if not selected_vlm_model:
                    if settings is None:
                        raise RuntimeError("vision model not configured (settings unavailable)")
                    selected_vlm_model = settings.vision_document.vision_model
                logger.info(
                    "Auto-selected VLM pipeline (%s) for PDF: %s",
                    selected_vlm_model,
                    file_path,
                )
            elif file_ext in ("png", "jpg", "jpeg", "bmp", "tiff"):
                selected_pipeline = "vlm"
                if not selected_vlm_model:
                    if settings is None:
                        raise RuntimeError("vision model not configured (settings unavailable)")
                    selected_vlm_model = settings.vision_document.vision_model
                logger.info(
                    "Auto-selected VLM pipeline (%s) for image: %s",
                    selected_vlm_model,
                    file_path,
                )
        
        # Build configuration
        config = {}
        if ocr_engine:
            config["ocr_engine"] = ocr_engine
        if selected_vlm_model:
            config["vlm_model"] = selected_vlm_model
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

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            result = asyncio.run(
                _convert_with_params(
                    service,
                    file_path,
                    selected_pipeline,
                    output_format,
                    config,
                )
            )
        else:
            # Fast path for background threads (no event loop) is handled above.
            if loop.is_running():
                result = service.run_coroutine_threadsafe(
                    _convert_with_params(
                        service,
                        file_path,
                        selected_pipeline,
                        output_format,
                        config,
                    ),
                    timeout=_EXECUTOR_TIMEOUT_SECONDS
                )
            else:
                result = loop.run_until_complete(
                    _convert_with_params(
                        service,
                        file_path,
                        selected_pipeline,
                        output_format,
                        config,
                    )
                )
        
        return result
        
    except Exception as e:
        error_msg = f"docling_convert error: {str(e)}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}


async def _convert_with_params(
    service,
    file_path: str,
    pipeline: str,
    output_format: str,
    config: Dict[str, Any],
) -> Dict[str, Any]:
    return await service.process_file(
        file_path=file_path,
        pipeline=pipeline,
        output_format=output_format,
        **config,
    )


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

