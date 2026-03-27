"""
Docling Service Integration - Layer 1 Implementation

Provides on-demand *in-process* document conversion via Docling (no server).

Features:
- On-demand conversion (file path / base64)
- Lightweight health check (import + basic capability inspection)

Production-ready with:
- Error handling
- Resource cleanup

Note:
This repo includes `services/docling/` and (in most environments) the `docling` package
is available. We intentionally do **not** depend on a separate Docling API server.

@.architecture
Incoming: api/v1/endpoints/ocr.py, services/docling --- {str file_path, str base64_content, str pipeline_name, Dict config}
Processing: convert_document(), convert_from_file(), convert_from_base64(), health_check() --- {JOB_FILE_READ, JOB_HEALTH_CHECK, JOB_TRANSFORM_DATA}
Outgoing: api/v1/endpoints/ocr.py --- {Dict[str, Any] document data with markdown/json/html, bool health status}
"""

import base64
import asyncio
import hashlib
import json
import logging
import sys
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Ensure vendored Docling package is importable (no server required).
# PyInstaller bundles services/docling/ flat to _internal/docling/ (no services/ prefix)
# Structure: _internal/docling/docling/__init__.py (nested package from Docling repo)
def _ensure_docling_importable():
    """Add vendored Docling to sys.path if needed and ensure all submodules are available."""
    try:
        import docling
        import docling.models
        # Explicitly check for plugins submodule which often fails in frozen binaries
        try:
            import docling.models.plugins
        except ImportError:
            logger.debug("docling.models.plugins not found, attempting to fix paths")
    except ImportError:
        pass
    
    if getattr(sys, 'frozen', False):
        # Frozen: PyInstaller bundles to _internal/docling/
        if hasattr(sys, '_MEIPASS'):
            # The actual package might be directly in _internal or nested
            base_path = Path(sys._MEIPASS)
            
            # Add base path to sys.path if not already there
            if str(base_path) not in sys.path:
                sys.path.insert(0, str(base_path))
                
            # Specifically check for docling submodules
            docling_path = base_path / "docling"
            if docling_path.exists() and str(docling_path) not in sys.path:
                # We don't necessarily want to add the package dir to sys.path,
                # but we want to ensure its parent is there so 'import docling' works.
                pass
    # Note: In development mode, vendored paths are injected into PYTHONPATH by main.py

_ensure_docling_importable()

# --- PYINSTALLER FIX: Pre-import transformers auto modules ---
# transformers uses __getattr__ lazy loading (via _LazyModule) to resolve classes
# like AutoProcessor, AutoModelForImageTextToText. In frozen binaries, this lazy
# resolution fails because importlib.import_module() inside the _LazyModule can't
# find submodules through PyInstaller's FrozenImporter. Pre-importing forces these
# modules into sys.modules so the lazy __getattr__ finds them already cached.
if getattr(sys, 'frozen', False):
    _pre_import_modules = [
        'transformers.models.auto.processing_auto',
        'transformers.models.auto.modeling_auto',
        'transformers.models.auto.image_processing_auto',
        'transformers.models.auto.tokenization_auto',
        'transformers.models.auto.configuration_auto',
        'transformers.models.auto.auto_factory',
    ]
    for _mod_name in _pre_import_modules:
        try:
            __import__(_mod_name)
        except Exception:
            logger.debug("Pre-import failed for %s (non-fatal)", _mod_name)

try:
    # Prefer installed docling package (or vendored package if installed in env).
    from docling.datamodel.base_models import ConversionStatus
    from docling.document_converter import DocumentConverter

    _DOCLING_AVAILABLE = True
except Exception as _docling_exc:  # noqa: BLE001
    logger.warning("Docling import failed: %s: %s", type(_docling_exc).__name__, _docling_exc)
    ConversionStatus = None  # type: ignore[assignment]
    DocumentConverter = None  # type: ignore[assignment]
    _DOCLING_AVAILABLE = False


class DoclingService:
    """
    In-process Docling conversion service.
    
    This is intentionally **not** an HTTP client. It runs Docling locally on demand.
    """
    
    def __init__(self, api_url: Optional[str] = None):  # api_url kept for backward compatibility
        self.api_url = (api_url or "inprocess://docling").rstrip("/")
        self._converter: Optional[Any] = None
        self._converter_key: Optional[str] = None
        self._executor = None
        logger.debug("Initialized DoclingService (in-process)")
    
    async def initialize(self) -> None:
        """Initialize Docling converter lazily."""
        if not _DOCLING_AVAILABLE:
            raise RuntimeError("Docling package is not available in this environment")
        if self._converter is None:
            self._converter = DocumentConverter()  # type: ignore[misc]
            logger.debug("Docling converter initialized")
        if self._executor is None:
            from concurrent.futures import ThreadPoolExecutor
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="docling-sync")
    
    async def close(self) -> None:
        """Release converter reference and executor."""
        self._converter = None
        if getattr(self, "_executor", None) is not None:
            self._executor.shutdown(wait=False)
            self._executor = None

    def run_coroutine_threadsafe(self, coro: Any, timeout: float = 300) -> Any:
        import asyncio
        from concurrent.futures import TimeoutError as ThreadTimeoutError

        if getattr(self, "_executor", None) is None:
            from concurrent.futures import ThreadPoolExecutor
            self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="docling-sync")

        def _run_in_new_loop(inner_coro: Any) -> Any:
            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                return loop.run_until_complete(inner_coro)
            finally:
                try:
                    loop.run_until_complete(loop.shutdown_asyncgens())
                except Exception:
                    pass
                asyncio.set_event_loop(None)
                loop.close()

        future = self._executor.submit(_run_in_new_loop, coro)
        try:
            return future.result(timeout=timeout)
        except ThreadTimeoutError as exc:
            future.cancel()
            raise RuntimeError("Docling conversion timed out") from exc
    
    def _convert_sync(
        self,
        file_path: str,
        converter: Optional[Any] = None,
    ) -> Any:
        if not _DOCLING_AVAILABLE:
            raise RuntimeError("Docling package is not available in this environment")
        active_converter = converter or self._converter
        if active_converter is None:
            active_converter = DocumentConverter()  # type: ignore[misc]
            self._converter = active_converter
            self._converter_key = None
        return active_converter.convert(Path(file_path), raises_on_error=False)

    def _export_sync(self, conv_res: Any, output_format: str) -> Tuple[str, str]:
        """
        Export converted document to desired textual format.
        Returns: (format_name, content)
        """
        fmt = (output_format or "markdown").lower()

        # Docling exports to disk; use temp files and read back.
        if fmt in ("markdown", "md", "text"):
            with NamedTemporaryFile(mode="r+", suffix=".md", delete=True, encoding="utf-8") as tmp:
                strict_text = fmt in ("text",)
                conv_res.document.save_as_markdown(  # type: ignore[attr-defined]
                    filename=tmp.name,
                    strict_text=strict_text,
                )
                tmp.seek(0)
                return ("markdown" if not strict_text else "text", tmp.read())

        if fmt in ("doctags", "document_tokens", "tokens"):
            with NamedTemporaryFile(mode="r+", suffix=".doctags", delete=True, encoding="utf-8") as tmp:
                conv_res.document.save_as_document_tokens(filename=tmp.name)  # type: ignore[attr-defined]
                tmp.seek(0)
                return ("doctags", tmp.read())

        if fmt in ("json",):
            # Pydantic v2 model; safe JSON dump
            try:
                return ("json", conv_res.model_dump_json(indent=2))  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return ("json", str(conv_res))

        # Default fallback
        with NamedTemporaryFile(mode="r+", suffix=".md", delete=True, encoding="utf-8") as tmp:
            conv_res.document.save_as_markdown(filename=tmp.name)  # type: ignore[attr-defined]
            tmp.seek(0)
            return ("markdown", tmp.read())

    def _resolve_llm_proxy_url(self) -> str:
        from config.settings import get_settings

        settings = get_settings()
        base_url = (settings.base_url or "").rstrip("/")
        if not base_url:
            raise RuntimeError("settings.base_url is empty; cannot build LLM proxy URL")

        parsed = urlparse(base_url)
        if not parsed.scheme or not parsed.netloc:
            raise RuntimeError(f"settings.base_url is not a valid URL: {base_url}")
        if parsed.hostname in {"0.0.0.0", "::"}:
            raise RuntimeError(
                "settings.base_url resolves to a non-routable host. "
                "Set SECURITY_BIND_HOST to 127.0.0.1 for internal LLM proxy calls."
            )

        return f"{base_url}/v1/llm/chat/completions"

    def _coerce_bool(self, value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "y"}
        if value is None:
            return default
        return bool(value)

    def _parse_languages(self, value: Any, fallback: str) -> list:
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        if isinstance(value, str):
            raw = value if value.strip() else fallback
            return [part.strip() for part in raw.split(",") if part.strip()]
        if fallback:
            return [part.strip() for part in fallback.split(",") if part.strip()]
        return []

    def _resolve_response_format(self, output_format: str):
        from docling.datamodel.pipeline_options_vlm_model import ResponseFormat

        fmt = (output_format or "markdown").lower()
        if fmt in {"doctags", "document_tokens", "tokens"}:
            return ResponseFormat.DOCTAGS
        if fmt in {"html"}:
            return ResponseFormat.HTML
        return ResponseFormat.MARKDOWN

    def _build_pdf_pipeline_options(
        self,
        *,
        ocr_engine: str,
        ocr_languages: list,
        enable_code_enrichment: bool,
        enable_formula_enrichment: bool,
        enable_picture_classification: bool,
        enable_picture_description: bool,
        llm_proxy_url: Optional[str],
        llm_model: Optional[str],
        timeout_seconds: Optional[float],
    ):
        from docling.datamodel.pipeline_options import (
            PdfPipelineOptions,
            OcrMacOptions,
            EasyOcrOptions,
            RapidOcrOptions,
            TesseractCliOcrOptions,
            TesseractOcrOptions,
            PictureDescriptionApiOptions,
        )

        engine = (ocr_engine or "").strip().lower()
        if engine == "ocrmac":
            ocr_options = OcrMacOptions(lang=ocr_languages)
        elif engine == "easyocr":
            ocr_options = EasyOcrOptions(lang=ocr_languages)
        elif engine == "rapidocr":
            ocr_options = RapidOcrOptions(lang=ocr_languages)
        elif engine == "tesseract_cli":
            ocr_options = TesseractCliOcrOptions(lang=ocr_languages)
        elif engine == "tesseract":
            ocr_options = TesseractOcrOptions(lang=ocr_languages)
        else:
            raise ValueError(f"Unsupported OCR engine: {ocr_engine}")

        pdf_options = PdfPipelineOptions(
            ocr_options=ocr_options,
            do_code_enrichment=enable_code_enrichment,
            do_formula_enrichment=enable_formula_enrichment,
            do_picture_classification=enable_picture_classification,
            do_picture_description=enable_picture_description,
        )

        if timeout_seconds is not None:
            pdf_options.document_timeout = float(timeout_seconds)

        if enable_picture_description:
            if not llm_proxy_url or not llm_model:
                raise RuntimeError("Picture description enabled but LLM proxy URL/model is missing")
            pdf_options.enable_remote_services = True
            pdf_options.picture_description_options = PictureDescriptionApiOptions(
                url=llm_proxy_url,
                params={"model": llm_model},
            )

        return pdf_options

    def _build_vlm_pipeline_options(
        self,
        *,
        llm_proxy_url: str,
        llm_model: str,
        output_format: str,
        timeout_seconds: Optional[float],
        api_key: str = "",
    ):
        from docling.datamodel.pipeline_options import VlmPipelineOptions
        from docling.datamodel.pipeline_options_vlm_model import ApiVlmOptions
        from docling.datamodel.vlm_model_specs import GRANITE_VISION_OLLAMA

        # Generic markdown-conversion prompt -- works with any VLM (InternVL, GLM-OCR, LLaVA, etc.)
        # GLM-OCR-specific task prompts ("Text Recognition:", "Table Recognition:") belong
        # only in the direct OCR backend (GlmOcrBackend), not here.
        vlm_prompt = GRANITE_VISION_OLLAMA.prompt

        headers: Dict[str, str] = {}
        if api_key and api_key != "not-needed":
            headers["Authorization"] = f"Bearer {api_key}"

        vlm_options = ApiVlmOptions(
            url=llm_proxy_url,
            params={"model": llm_model},
            headers=headers,
            prompt=vlm_prompt,
            response_format=self._resolve_response_format(output_format),
            timeout=float(timeout_seconds) if timeout_seconds is not None else 120.0,
        )
        return VlmPipelineOptions(
            vlm_options=vlm_options,
            enable_remote_services=True,
        )

    def _get_converter(
        self,
        *,
        pipeline: str,
        ocr_engine: Optional[str],
        vlm_model: Optional[str],
        output_format: str,
        **kwargs: Any,
    ) -> Any:
        if not _DOCLING_AVAILABLE:
            raise RuntimeError("Docling package is not available in this environment")

        from docling.document_converter import DocumentConverter, FormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.backend.docling_parse_v4_backend import DoclingParseV4DocumentBackend
        from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
        from docling.pipeline.vlm_pipeline import VlmPipeline

        from config.settings import get_settings

        settings = get_settings()
        vision_doc = settings.vision_document

        normalized_pipeline = (pipeline or "standard").strip().lower()

        resolved_ocr = (ocr_engine or vision_doc.ocr_engine).strip().lower()
        resolved_output_format = output_format or vision_doc.output_format

        # Auto-route glm-ocr (VLM model) to VLM pipeline if using default "standard"
        if resolved_ocr == "glm-ocr" and normalized_pipeline == "standard":
            normalized_pipeline = "vlm"

        pipeline_kind = "vlm" if normalized_pipeline == "vlm" else "standard"

        # --- VLM URL/model resolution (provider-agnostic) ---
        # Single path: resolve via vision_document.provider_config for ANY provider
        # (aether_inference, openai-compatible/LM Studio, ollama, etc.)
        # Caller kwargs can override for backward compat.
        llm_proxy_url = kwargs.get("lm_studio_url")   # caller override
        llm_model = kwargs.get("lm_studio_model")       # caller override
        api_key = ""

        if not llm_proxy_url or not llm_model:
            svc_api_base, svc_model, svc_api_key = settings.resolve_service_provider(
                vision_doc.provider_config, service_type="vision"
            )
            if not llm_proxy_url:
                llm_proxy_url = f"{svc_api_base.rstrip('/')}/chat/completions"
            if not llm_model:
                llm_model = svc_model
            api_key = svc_api_key or ""

        if not llm_model:
            raise RuntimeError(
                "No OCR/VLM model resolved. Check vision_document.provider_config.model "
                "(GLM-OCR) or inference.default_vision_model (LFM VL) in settings."
            )

        enable_code_enrichment = self._coerce_bool(
            kwargs.get("enable_code_enrichment"), vision_doc.enable_code_enrichment
        )
        enable_formula_enrichment = self._coerce_bool(
            kwargs.get("enable_formula_enrichment"), vision_doc.enable_formula_enrichment
        )
        enable_picture_classification = self._coerce_bool(
            kwargs.get("enable_picture_classification"), vision_doc.enable_picture_classification
        )
        enable_picture_description = self._coerce_bool(
            kwargs.get("enable_picture_description"), vision_doc.enable_picture_description
        )
        ocr_languages = self._parse_languages(kwargs.get("ocr_languages"), vision_doc.ocr_languages)
        timeout_seconds = getattr(getattr(settings, "websocket", None), "document_processing_timeout", None)

        format_options: Dict[InputFormat, FormatOption] = {}
        if pipeline_kind == "vlm":
            vlm_options = self._build_vlm_pipeline_options(
                llm_proxy_url=llm_proxy_url,
                llm_model=llm_model,
                output_format=resolved_output_format,
                timeout_seconds=getattr(getattr(settings, "websocket", None), "image_processing_timeout", None),
                api_key=api_key,
            )
            format_options[InputFormat.PDF] = FormatOption(
                pipeline_cls=VlmPipeline,
                pipeline_options=vlm_options,
                backend=DoclingParseV4DocumentBackend,
            )
            format_options[InputFormat.IMAGE] = FormatOption(
                pipeline_cls=VlmPipeline,
                pipeline_options=vlm_options,
                backend=DoclingParseV4DocumentBackend,
            )
        else:
            pdf_options = self._build_pdf_pipeline_options(
                ocr_engine=resolved_ocr,
                ocr_languages=ocr_languages,
                enable_code_enrichment=enable_code_enrichment,
                enable_formula_enrichment=enable_formula_enrichment,
                enable_picture_classification=enable_picture_classification,
                enable_picture_description=enable_picture_description,
                llm_proxy_url=llm_proxy_url,
                llm_model=llm_model,
                timeout_seconds=timeout_seconds,
            )
            format_options[InputFormat.PDF] = FormatOption(
                pipeline_cls=StandardPdfPipeline,
                pipeline_options=pdf_options,
                backend=DoclingParseV4DocumentBackend,
            )
            format_options[InputFormat.IMAGE] = FormatOption(
                pipeline_cls=StandardPdfPipeline,
                pipeline_options=pdf_options,
                backend=DoclingParseV4DocumentBackend,
            )

        key_payload = {
            "pipeline": pipeline_kind,
            "ocr_engine": resolved_ocr,
            "output_format": resolved_output_format,
            "llm_proxy_url": llm_proxy_url,
            "llm_model": llm_model,
            "enable_code_enrichment": enable_code_enrichment,
            "enable_formula_enrichment": enable_formula_enrichment,
            "enable_picture_classification": enable_picture_classification,
            "enable_picture_description": enable_picture_description,
            "ocr_languages": ocr_languages,
        }
        key = hashlib.sha256(json.dumps(key_payload, sort_keys=True).encode("utf-8")).hexdigest()

        if self._converter is None or self._converter_key != key:
            self._converter = DocumentConverter(format_options=format_options)
            self._converter_key = key

        return self._converter

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
            pipeline: Pipeline type (vlm, standard)
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

            import time
            start = time.time()

            converter = self._get_converter(
                pipeline=pipeline,
                ocr_engine=ocr_engine,
                vlm_model=vlm_model,
                output_format=output_format,
                **kwargs,
            )

            # Convert in a worker thread to keep this method async-friendly.
            conv_res = await asyncio.to_thread(self._convert_sync, str(path), converter)

            processing_time = time.time() - start

            status = getattr(conv_res, "status", None)
            ok_statuses = set()
            if ConversionStatus is not None:
                ok_statuses = {ConversionStatus.SUCCESS, ConversionStatus.PARTIAL_SUCCESS}

            success = bool(ok_statuses and status in ok_statuses) or bool(getattr(conv_res, "document", None))
            exported_format, content = await asyncio.to_thread(self._export_sync, conv_res, output_format)

            pages_processed = 0
            try:
                pages_processed = len(getattr(conv_res, "pages", []) or [])
            except Exception:  # noqa: BLE001
                pages_processed = 0

            engine_used = "docling_inprocess"
            if pipeline:
                engine_used += f":{pipeline}"
            if vlm_model:
                engine_used += f":{vlm_model}"
            if ocr_engine:
                engine_used += f":{ocr_engine}"

            logger.info("Docling processed %s (pipeline=%s)", path.name, pipeline)
            return {
                "success": success,
                "content": content,
                "format": exported_format,
                "engine_used": engine_used,
                "processing_time": round(processing_time, 3),
                "pages_processed": pages_processed or 1,
                "file_info": {
                    "name": path.name,
                    "path": str(path),
                    "size_bytes": path.stat().st_size if path.exists() else None,
                },
                "metadata": {
                    "kwargs": {k: str(v) for k, v in kwargs.items() if v is not None},
                },
            }

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
            file_bytes = base64.b64decode(base64_content)
            suffix = Path(filename).suffix or ".bin"
            with NamedTemporaryFile(delete=True, suffix=suffix) as tmp:
                tmp.write(file_bytes)
                tmp.flush()
                return await self.process_file(
                    file_path=tmp.name,
                    pipeline=pipeline,
                    output_format=output_format,
                    **kwargs,
                )
                
        except Exception as e:
            error_msg = f"Processing error: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    @staticmethod
    def _check_inference_vision_available() -> bool:
        """Check if inference server has a vision model available for GLM-OCR."""
        try:
            from services.aether_inference.manager import InferenceManager, ServerStatus
            manager = InferenceManager.get_instance()
            return manager.status == ServerStatus.RUNNING
        except (ImportError, AttributeError, RuntimeError):
            return False

    def _build_ocr_engine_options(self) -> list:
        """Build dynamic OCR engine options based on available services.

        Returns list of dicts with value, label, available, description.
        Frontend consumes this to populate the dropdown — no hardcoding needed.
        """
        import platform

        inference_available = self._check_inference_vision_available()
        is_macos = platform.system() == "Darwin"

        # Order: best first. GLM-OCR is the premium option when inference is up.
        engines = [
            {
                "value": "glm-ocr",
                "label": "GLM-OCR (Vision AI)",
                "available": inference_available,
                "description": "Vision language model OCR via local inference server",
            },
        ]

        if is_macos:
            engines.append({
                "value": "ocrmac",
                "label": "OCR Mac (Native)",
                "available": True,
                "description": "Apple native OCR engine (macOS only)",
            })

        engines.extend([
            {
                "value": "easyocr",
                "label": "EasyOCR",
                "available": True,
                "description": "Neural network OCR (multi-language)",
            },
            {
                "value": "tesseract",
                "label": "Tesseract",
                "available": True,
                "description": "Open source OCR engine",
            },
            {
                "value": "rapidocr",
                "label": "RapidOCR",
                "available": True,
                "description": "Fast lightweight OCR engine",
            },
        ])

        return engines

    def health_check(self) -> Dict[str, Any]:
        """
        In-process Docling health check (synchronous).

        Returns:
            Dict with:
                - healthy: bool (overall health status)
                - status: str (active, error)
                - url: str ("inprocess://docling")
                - version: str (best-effort)
                - pipelines: list (supported pipeline labels in our wrapper)
                - ocr_engines: list (flat list of engine value strings)
                - ocr_engine_options: list (rich objects with value/label/available/description)
                - response_time_ms: float
                - error: str (if failed)
        """
        import time

        result: Dict[str, Any] = {
            "healthy": False,
            "status": "error",
            "url": self.api_url,
            "version": "unknown",
            "pipelines": [],
            "ocr_engines": [],
            "ocr_engine_options": [],
            "response_time_ms": 0.0,
        }

        try:
            start_time = time.time()
            result["response_time_ms"] = round((time.time() - start_time) * 1000, 2)
            if not _DOCLING_AVAILABLE:
                result["error"] = "Docling package not available"
                return result

            # Basic sanity: instantiate converter (cheap)
            if self._converter is None:
                self._converter = DocumentConverter()  # type: ignore[misc]

            result["pipelines"] = ["standard", "vlm"]  # wrapper-level labels

            engine_options = self._build_ocr_engine_options()
            result["ocr_engine_options"] = engine_options
            # Flat list for backward compat (only available engines)
            result["ocr_engines"] = [e["value"] for e in engine_options if e["available"]]

            # Output format options for frontend dropdown population
            result["output_formats"] = ["markdown", "doctags", "json", "text"]
            result["output_format_options"] = [
                {"value": "markdown", "label": "Markdown"},
                {"value": "doctags", "label": "DocTags (structured)"},
                {"value": "json", "label": "JSON"},
                {"value": "text", "label": "Plain Text"},
            ]

            result["status"] = "active"
            result["healthy"] = True

        except Exception as exc:
            result["error"] = str(exc)
            result["error_type"] = type(exc).__name__
            logger.error("Docling health check error: %s", result["error"], exc_info=True)

        return result

    async def get_supported_formats(self) -> Dict[str, Any]:
        """
        Get supported file formats and pipelines.

        Returns:
            Dict with supported formats info
        """
        try:
            await self.initialize()
            engine_options = self._build_ocr_engine_options()
            return {
                "pipelines": ["standard", "vlm"],
                "ocr_engines": [e["value"] for e in engine_options if e["available"]],
                "ocr_engine_options": engine_options,
                "output_formats": ["markdown", "doctags", "json", "text"],
                "output_format_options": [
                    {"value": "markdown", "label": "Markdown"},
                    {"value": "doctags", "label": "DocTags (structured)"},
                    {"value": "json", "label": "JSON"},
                    {"value": "text", "label": "Plain Text"},
                ],
            }
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}


# Singleton instance for shared use
_docling_service: Optional[DoclingService] = None


def get_docling_service(api_url: Optional[str] = None) -> DoclingService:
    """
    Get or create singleton Docling service instance.
    
    Args:
        api_url: Legacy docling URL (unused in-process; retained for compatibility)
        
    Returns:
        DoclingService instance
    """
    global _docling_service
    
    if _docling_service is None:
        _docling_service = DoclingService(api_url)
        logger.debug("Created singleton DoclingService instance")
    
    return _docling_service

