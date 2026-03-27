"""
Document Processor

Processes documents via in-process Docling with InternVL image analysis and LLM integration.
Handles file uploads, type detection, and structured extraction.

@.architecture
Incoming: core/runtime/engine.py, api/v1/endpoints/file.py --- {file_path, user_prompt, file_data}
Processing: process_file(), process_file_chat(), detect_file_type() --- {3 jobs: JOB_FILE_READ, JOB_HTTP_REQUEST, JOB_TRANSFORM_DATA}
Outgoing: Docling in-process conversion, core/runtime/interpreter.py --- {Dict[str, Any], structured_doc}
"""

import inspect
import base64
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional, Union
from urllib.parse import urlparse

from config.settings import get_settings

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """
    Processes documents and files with in-process Docling and LLM analysis.
    
    Features:
    - Standard Docling pipeline for PDFs and documents with advanced OCR
    - Vision model for image analysis (resolved via vision_document.provider_config)
    - Vision LLM direct processing for images (when vision-capable)
    - File upload validation and processing
    - LLM integration for document analysis
    - Progress tracking and UI feedback
    - Combined prompt generation for context
    
    Supported File Types:
    - PDFs (via standard Docling with OCR)
    - Images (via InternVL for text LLMs, direct for vision LLMs)
    - Other documents (via standard Docling pipeline)
    """

    def __init__(self, config_manager: Optional[Any] = None, request_tracker: Optional[Any] = None):
        """
        Initialize document processor with optional shared dependencies.
        """
        if config_manager is None:
            from .config import ConfigManager

            config_manager = ConfigManager()
        if request_tracker is None:
            from .request import RequestTracker

            request_tracker = RequestTracker()
        self._config_manager = config_manager
        self._request_tracker = request_tracker
        
        # Docling runs in-process; no external URL needed.

    def _resolve_llm_proxy_url(self) -> str:
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

    # ============================================================================
    # LOCAL FILE PROCESSING HELPERS
    # ============================================================================

    async def detect_file_type(self, file_path: Path) -> str:
        """
        Detect the file type using extension and signature checks.
        """
        signature = await self._read_file_head(file_path, 8)
        suffix = file_path.suffix.lower()

        if suffix == ".pdf" or signature.startswith(b"%PDF"):
            return "pdf"
        if suffix in {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff"}:
            return "image"
        if suffix in {".txt", ".md", ".csv"}:
            return "text"
        if signature.startswith(b"PK\x03\x04") or suffix in {".docx", ".xlsx"}:
            return "archive"
        return "binary"

    async def process_file(
        self,
        file_input: Optional[Union[Path, str, Dict[str, Any]]] = None,
        *,
        base64_data: Optional[str] = None,
        filename: Optional[str] = None,
        user_prompt: str = "",
    ) -> Dict[str, Any]:
        """
        Process a file provided either as a filesystem path or base64 payload.
        
        Routing logic:
        - PDFs/documents via file path → Docling OCR pipeline (full extraction, all pages)
        - Images via file path → Vision model or Docling VLM pipeline
        - PDFs/documents via base64 → Docling OCR pipeline
        - Images via base64 with text-only LLM → Vision model (InternVL via backend LLM proxy)
        - Images via base64 with vision LLM → Docling VLM pipeline
        """
        if file_input is not None:
            file_path = Path(file_input)
            if not file_path.exists():
                raise FileNotFoundError(f"File does not exist: {file_path}")

            file_type = await self.detect_file_type(file_path)

            if file_type == "pdf":
                # Route through Docling OCR pipeline -- processes all pages, no truncation.
                # Uses configured OCR engine (easyocr/ocrmac/tesseract/rapidocr).
                logger.info("Routing PDF %s to Docling OCR pipeline", file_path.name)
                return await self._process_docling_filepath(file_path, user_prompt)

            if file_type == "image":
                # Route through vision/Docling VLM pipeline (not a dead placeholder).
                logger.info("Routing image %s to vision pipeline", file_path.name)
                return await self._process_image_filepath(file_path, user_prompt)

            if file_type == "archive":
                # Office documents (docx, xlsx) -- Docling handles these too.
                logger.info("Routing archive %s to Docling pipeline", file_path.name)
                return await self._process_docling_filepath(file_path, user_prompt)

            # Plain text files -- direct read (no OCR needed).
            text = await _maybe_await(self._extract_text(file_path))
            return {
                "success": True,
                "type": file_type,
                "text": text,
                "content": text,
                "format": "text",
                "engine_used": "direct_read",
                "processing_time": 0,
                "pages_processed": 1,
                "combined_prompt": self._create_combined_prompt(text, user_prompt, file_path.name),
            }

        if base64_data is not None and filename is not None:
            # Check if image
            file_ext = Path(filename).suffix.lower()
            is_image = file_ext in [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"]
            
            # Load settings
            settings = get_settings()
            
            if is_image and not settings.llm.supports_vision:
                # Text-only LLM → Route to vision model
                logger.info("Routing image %s to vision model (text-only LLM)", filename)
                return await self._process_with_vision_model(
                    base64_data=base64_data,
                    filename=filename,
                    user_prompt=user_prompt,
                )
            else:
                # PDFs/documents OR images with vision LLM → Docling
                logger.info("Routing %s to Docling", filename)
                return await self._process_docling_base64(
                    base64_data=base64_data,
                    filename=filename,
                    user_prompt=user_prompt,
                )

        raise ValueError("Either file_input or (base64_data + filename) must be provided.")

    async def extract_tables(self, file_path: Union[str, Path]) -> list:
        """
        Extract structured table data from a file (patch-friendly hook).
        """
        return await _maybe_await(self._extract_tables(Path(file_path)))

    # ============================================================================
    # VISION MODEL PROCESSING
    # ============================================================================

    async def _process_with_vision_model(
        self,
        *,
        base64_data: str,
        filename: str,
        user_prompt: str,
    ) -> Dict[str, Any]:
        """
        Process an image using the configured vision model (provider-agnostic).
        
        Resolves the vision provider via resolve_service_provider -- works with
        aether_inference, LM Studio, Ollama, or any OpenAI-compatible endpoint.
        
        This is used when the primary LLM is text-only but we need vision capabilities.
        The vision model generates a description that can then be injected into the
        text LLM's context.
        
        Args:
            base64_data: Base64 encoded image data
            filename: Original filename for reference
            user_prompt: Optional user prompt for guided analysis
            
        Returns:
            Dictionary with:
                - success: bool
                - text: Generated image description
                - content: Same as text (for compatibility)
                - format: "vision_description"
                - engine_used: Model identifier
        """
        import httpx
        
        try:
            settings = get_settings()
            vision_settings = settings.vision_document
            
            # Resolve vision provider (aether_inference / LM Studio / Ollama / etc.)
            provider_url, vision_model, api_key = settings.resolve_service_provider(
                vision_settings.provider_config, service_type="vision"
            )
            if not vision_model:
                raise RuntimeError(
                    "No OCR/vision model resolved. Check vision_document.provider_config.model "
                    "(GLM-OCR) or inference.default_vision_model (LFM VL) in settings."
                )
            
            llm_url = f"{provider_url.rstrip('/')}/chat/completions"
            
            # Prepare the vision API request (OpenAI-compatible)
            payload = {
                "model": vision_model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": user_prompt or "Analyze this image in detail. Describe what you see, including any text, objects, people, colors, layout, and context."
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:image/jpeg;base64,{base64_data}"
                                }
                            }
                        ]
                    }
                ],
                "max_tokens": getattr(vision_settings, "max_tokens", settings.llm.max_tokens),
                "temperature": getattr(vision_settings, "temperature", settings.llm.temperature),
            }
            
            headers: Dict[str, str] = {"Content-Type": "application/json"}
            if api_key and api_key != "not-needed":
                headers["Authorization"] = f"Bearer {api_key}"
            
            logger.info("Sending image %s to vision model %s via %s", filename, vision_model, llm_url)
            
            timeout_seconds = getattr(getattr(settings, "websocket", None), "image_processing_timeout", 120.0)
            async with httpx.AsyncClient(timeout=timeout_seconds) as client:
                response = await client.post(
                    llm_url,
                    json=payload,
                    headers=headers,
                )
                
                response.raise_for_status()
                result = response.json()
                
                # Extract the vision model's response
                description = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                
                if not description:
                    raise ValueError("Vision model returned empty response")
                
                logger.info("Vision model processed %s: %d chars", filename, len(description))
                
                combined_prompt = self._create_combined_prompt(description, user_prompt, filename)
                return {
                    "success": True,
                    "text": description,
                    "content": description,
                    "format": "vision_description",
                    "engine_used": f"vision-{vision_model}",
                    "combined_prompt": combined_prompt,
                }
                
        except httpx.HTTPStatusError as exc:
            logger.error("Vision model HTTP error: %s - %s", exc.response.status_code, exc.response.text)
            return self._build_error_response(
                f"Vision model API error: {exc.response.status_code}"
            )
        except Exception as exc:  # noqa: BLE001 -- vision model boundary: must return error response, never crash
            logger.error("Error processing image with vision model: %s", exc, exc_info=True)
            return self._build_error_response(
                "Failed to process with vision model. Check server logs for details."
            )

    # ============================================================================
    # FILE PATH PROCESSING (Docling OCR / Vision pipeline)
    # ============================================================================

    async def _process_docling_filepath(
        self,
        file_path: Path,
        user_prompt: str,
    ) -> Dict[str, Any]:
        """
        Process a document from filesystem path via Docling OCR pipeline.
        
        Uses DoclingService.process_file() which:
        - Applies the configured OCR engine (easyocr/ocrmac/tesseract/rapidocr)
        - Processes ALL pages (no page limit truncation)
        - Extracts tables, formulas, code blocks when enrichment is enabled
        - Supports standard PDF pipeline and VLM pipeline
        
        Args:
            file_path: Path to document file
            user_prompt: Optional user prompt for guided analysis
            
        Returns:
            Full response dict with content, metadata, combined_prompt
        """
        from core.integrations.providers.docling import get_docling_service
        
        try:
            config = self._get_pipeline_config(file_path.name)
            service = get_docling_service()
            result = await service.process_file(
                file_path=str(file_path),
                pipeline=config["pipeline"],
                output_format=config["output_format"],
                ocr_engine=config.get("ocr_engine"),
                enable_code_enrichment=config.get("enable_code_enrichment"),
                enable_formula_enrichment=config.get("enable_formula_enrichment"),
                enable_picture_classification=config.get("enable_picture_classification"),
                enable_picture_description=config.get("enable_picture_description"),
                ocr_languages=config.get("ocr_languages"),
            )
            if result.get("success"):
                return self._build_success_response(result, user_prompt, file_path.name)
            return self._build_error_response(result.get("error", "Docling conversion failed"))
                    
        except Exception as exc:  # noqa: BLE001 -- Docling boundary: must return error response, never crash
            logger.error("Error processing file with Docling (filepath): %s", exc, exc_info=True)
            return self._build_error_response(
                "Failed to process file with Docling. Check server logs for details."
            )

    async def _process_image_filepath(
        self,
        file_path: Path,
        user_prompt: str,
    ) -> Dict[str, Any]:
        """
        Process an image from filesystem path via vision pipeline.
        
        Routing:
        - Text-only LLM → Vision model (InternVL/GLM-OCR via inference server)
        - Vision-capable LLM → Docling VLM pipeline
        
        Args:
            file_path: Path to image file
            user_prompt: Optional user prompt for guided analysis
            
        Returns:
            Full response dict with content, metadata, combined_prompt
        """
        try:
            # Read file and encode to base64
            file_bytes = file_path.read_bytes()
            base64_data = base64.b64encode(file_bytes).decode("utf-8")
            
            settings = get_settings()
            
            if not settings.llm.supports_vision:
                # Text-only LLM → Route to vision model
                logger.info("Routing image %s to vision model (text-only LLM)", file_path.name)
                return await self._process_with_vision_model(
                    base64_data=base64_data,
                    filename=file_path.name,
                    user_prompt=user_prompt,
                )
            else:
                # Vision LLM → Docling VLM pipeline
                logger.info("Routing image %s to Docling VLM pipeline", file_path.name)
                return await self._process_docling_base64(
                    base64_data=base64_data,
                    filename=file_path.name,
                    user_prompt=user_prompt,
                )
                
        except Exception as exc:  # noqa: BLE001 -- image processing boundary: must return error response, never crash
            logger.error("Error processing image (filepath): %s", exc, exc_info=True)
            return self._build_error_response(
                "Failed to process image. Check server logs for details."
            )

    # ============================================================================
    # DOCUMENT CONVERSION (base64 path)
    # ============================================================================

    async def _process_docling_base64(
        self,
        *,
        base64_data: str,
        filename: str,
        user_prompt: str,
    ) -> Dict[str, Any]:
        """
        Process a file using Docling service (in-process).
        """
        from core.integrations.providers.docling import get_docling_service
        
        try:
            config = self._get_pipeline_config(filename)
            service = get_docling_service()
            result = await service.process_base64(
                base64_content=base64_data,
                filename=filename,
                pipeline=config["pipeline"],
                output_format=config["output_format"],
                ocr_engine=config.get("ocr_engine"),
                enable_code_enrichment=config.get("enable_code_enrichment"),
                enable_formula_enrichment=config.get("enable_formula_enrichment"),
                enable_picture_classification=config.get("enable_picture_classification"),
                enable_picture_description=config.get("enable_picture_description"),
                ocr_languages=config.get("ocr_languages"),
            )
            if result.get("success"):
                return self._build_success_response(result, user_prompt, filename)
            return self._build_error_response(result.get("error", "Docling conversion failed"))
                    
        except Exception as exc:  # noqa: BLE001 -- Docling boundary: must return error response, never crash
            logger.error("Error processing file with Docling: %s", exc, exc_info=True)
            return self._build_error_response(
                "Failed to process file with Docling. Check server logs for details."
            )

    def _get_pipeline_config(self, filename: str) -> Dict[str, Any]:
        """Determine optimal pipeline configuration based on file type.
        
        VLM model URL/name are resolved inside docling's _get_converter via
        resolve_service_provider -- no need to pass model details from here.
        """
        file_ext = Path(filename).suffix.lower()
        
        settings = get_settings()
        vision_doc = settings.vision_document
        
        if file_ext in [".jpg", ".jpeg", ".png", ".tiff", ".bmp", ".webp"]:
            logger.info("Using VLM pipeline for %s - image analysis", filename)
            config: Dict[str, Any] = {
                "pipeline": "vlm",
                "output_format": vision_doc.output_format,
            }
        else:
            logger.info("Using standard Docling pipeline for %s", filename)
            config = {
                "pipeline": "standard",
                "ocr_engine": vision_doc.ocr_engine,
                "output_format": vision_doc.output_format,
            }

        config.update({
            "enable_code_enrichment": vision_doc.enable_code_enrichment,
            "enable_formula_enrichment": vision_doc.enable_formula_enrichment,
            "enable_picture_classification": vision_doc.enable_picture_classification,
            "enable_picture_description": vision_doc.enable_picture_description,
            "ocr_languages": vision_doc.ocr_languages,
        })

        return config

    def _build_api_payload(
        self, config: Dict[str, Any], user_prompt: str
    ) -> Dict[str, Any]:
        """Build API payload with high accuracy settings.
        
        VLM model URL/name are resolved inside docling's _get_converter via
        resolve_service_provider -- no need to pass model details from here.
        """
        settings = get_settings()
        vision_doc = settings.vision_document
        
        return {
            "pipeline": config["pipeline"],
            "ocr_engine": config.get("ocr_engine", vision_doc.ocr_engine),
            "output_format": config["output_format"],
            "enable_code_enrichment": vision_doc.enable_code_enrichment,
            "enable_formula_enrichment": vision_doc.enable_formula_enrichment,
            "enable_picture_classification": vision_doc.enable_picture_classification,
            "enable_picture_description": vision_doc.enable_picture_description,
            "ocr_languages": vision_doc.ocr_languages,
        }

    def _build_success_response(
        self, api_result: Dict[str, Any], user_prompt: str, filename: str
    ) -> Dict[str, Any]:
        """Build success response with processed content.
        
        Returns both 'content' and 'text' keys for backward compatibility.
        Callers may check either key (artifact_processor checks both).
        """
        content = api_result.get("content", "")
        combined_prompt = self._create_combined_prompt(content, user_prompt, filename)
        
        return {
            "success": True,
            "text": content,  # backward compat (callers may check 'text' or 'content')
            "content": content,
            "format": api_result.get("format", "markdown"),
            "engine_used": api_result.get("engine_used", "docling-api"),
            "processing_time": api_result.get("processing_time", 0),
            "pages_processed": api_result.get("pages_processed", 1),
            "combined_prompt": combined_prompt,
        }

    def _build_error_response(self, error_message: str) -> Dict[str, Any]:
        """Build error response."""
        return {"success": False, "error": error_message}

    def _create_combined_prompt(
        self, content: str, user_prompt: str, filename: str
    ) -> str:
        """Create a combined prompt for LLM analysis."""
        if not content:
            return user_prompt
            
        base_prompt = f"File: {filename}\n\nExtracted Content:\n{content}"
        
        if user_prompt:
            return (
                f"{base_prompt}\n\n"
                f"User Request: {user_prompt}\n\n"
                "Please analyze this document and respond to the user's request."
            )
        else:
            return (
                f"{base_prompt}\n\n"
                "Please analyze this document and provide insights about its content."
            )

    # ============================================================================
    # FILE CHAT INTEGRATION
    # ============================================================================

    async def process_file_chat(
        self,
        file_data: Dict[str, Any],
        prompt: str,
        request_id: Optional[str],
        interpreter: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        Process a file and optionally analyze with LLM.
        
        Args:
            file_data: File metadata (name, base64, category, etc.)
            prompt: User prompt for analysis
            request_id: Optional request identifier
            interpreter: Optional OI interpreter for analysis
            
        Returns:
            Processing result with status and metadata
        """
        # Generate request ID if not provided
        if not request_id:
            request_id = f"file_{int(time.time() * 1000)}"
        
        # Start tracking this request
        await self._request_tracker.start_request(
            request_id,
            "file_processor",
            text=prompt,
            chat_id=file_data.get("chat_id") or file_data.get("session_id") or request_id,
        )
        
        try:
            # Validate file data
            if not self._validate_file_data(file_data):
                return self._create_error_response("Invalid file data provided", request_id)
            
            # Initialize interpreter if needed
            if not interpreter:
                return self._create_error_response("Interpreter not available", request_id)
            
            # Extract file information
            file_name = file_data.get("name", "unknown_file")
            file_base64 = file_data.get("base64", "")
            
            # Send processing start message to UI
            await self._send_processing_start_message(
                interpreter, file_name, prompt, request_id
            )
            
            # Process file with Docling
            result = await self.process_file(
                base64_data=file_base64, filename=file_name, user_prompt=prompt
            )
            
            # Handle processing result
            if result.get("success"):
                return await self._handle_success_result(
                    result, file_name, prompt, request_id, interpreter
                )
            else:
                return await self._handle_error_result(
                    result, file_name, request_id, interpreter
                )
                
        except Exception as e:  # noqa: BLE001 -- file processing boundary: must return error response, never crash
            logger.error("File processing error for request %s: %s", request_id, e, exc_info=True)
            
            generic_msg = "File processing failed. Check server logs for details."
            # Send error message to UI
            await self._send_error_message(interpreter, generic_msg, request_id)
            
            return self._create_error_response(generic_msg, request_id)
            
        finally:
            # Clean up request tracking
            await self._request_tracker.end_request(request_id)

    async def process_file_chat_multipart(
        self,
        file_data: Dict[str, Any],
        prompt: str,
        request_id: Optional[str],
        interpreter: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """
        Process a multipart file upload with document analysis.
        
        CRITICAL BUG FIX: Added missing return statement (line 292 in old code)
        
        Args:
            file_data: File data with UploadFile object
            prompt: User prompt for analysis
            request_id: Optional request identifier
            interpreter: Optional OI interpreter for analysis
            
        Returns:
            Processing result with status and metadata
        """
        # Generate request ID if not provided
        if not request_id:
            request_id = f"file-{time.time()}"
        
        # Start tracking this request
        await self._request_tracker.start_request(
            request_id,
            "file_processor",
            text=prompt,
            chat_id=file_data.get("chat_id") or file_data.get("session_id") or request_id,
        )
        
        try:
            # Validate file object
            file_object = file_data.get("file_object")
            if not file_object:
                return self._create_error_response("No file object provided", request_id)
            
            # Initialize interpreter if needed
            if not interpreter:
                return self._create_error_response("Interpreter not available", request_id)
            
            # Extract file information
            file_name = file_data.get("name", "unknown")
            
            # Send processing start message
            await self._send_processing_start_message(
                interpreter, file_name, prompt, request_id
            )
            
            # Read file content
            file_content = await file_object.read()
            
            # Convert to base64
            base64_data = base64.b64encode(file_content).decode("utf-8")
            
            # Process file with Docling
            result = await self.process_file(
                base64_data=base64_data, filename=file_name, user_prompt=prompt
            )
            
            # Handle result using same logic as base64 method
            # BUG FIX: Added missing return statement here (line 292 in old code)
            if result.get("success"):
                return await self._handle_success_result(
                    result, file_name, prompt, request_id, interpreter
                )
            else:
                return await self._handle_error_result(
                    result, file_name, request_id, interpreter
                )
                
        except Exception as e:  # noqa: BLE001 -- multipart processing boundary: must return error response, never crash
            logger.error("Multipart file processing error for request %s: %s", request_id, e, exc_info=True)
            
            generic_msg = "Multipart file processing failed. Check server logs for details."
            await self._send_error_message(interpreter, generic_msg, request_id)
            return self._create_error_response(generic_msg, request_id)
            
        finally:
            # Clean up request tracking
            await self._request_tracker.end_request(request_id)

    # ============================================================================
    # HELPER METHODS
    # ============================================================================

    async def _read_file_head(self, file_path: Path, size: int) -> bytes:
        with file_path.open("rb") as handle:
            return handle.read(size)

    async def _extract_pdf_text(self, file_path: Path) -> str:
        """
        Fallback PDF text extraction (used only when Docling pipeline is unavailable).
        
        Attempts lightweight text extraction via PyMuPDF/pdfplumber if available,
        otherwise returns empty string (callers should use _process_docling_filepath instead).
        """
        # Try PyMuPDF (fitz) for lightweight text extraction
        try:
            import fitz  # type: ignore[import-untyped]
            doc = fitz.open(str(file_path))
            pages_text = []
            for page in doc:
                pages_text.append(page.get_text("text"))
            doc.close()
            text = "\n\n".join(pages_text)
            if text.strip():
                logger.info("PDF fallback extraction via PyMuPDF: %d chars, %d pages", len(text), len(pages_text))
                return text
        except ImportError:
            logger.debug("PyMuPDF not available for fallback PDF extraction")
        except (RuntimeError, ValueError, OSError) as exc:
            logger.debug("PyMuPDF fallback failed for %s: %s", file_path, exc)
        
        # Try pdfplumber as secondary fallback
        try:
            import pdfplumber  # type: ignore[import-untyped]
            with pdfplumber.open(str(file_path)) as pdf:
                pages_text = []
                for page in pdf.pages:
                    page_text = page.extract_text() or ""
                    pages_text.append(page_text)
            text = "\n\n".join(pages_text)
            if text.strip():
                logger.info("PDF fallback extraction via pdfplumber: %d chars, %d pages", len(text), len(pages_text))
                return text
        except ImportError:
            logger.debug("pdfplumber not available for fallback PDF extraction")
        except (RuntimeError, ValueError, OSError) as exc:
            logger.debug("pdfplumber fallback failed for %s: %s", file_path, exc)
        
        logger.warning("No PDF text extraction available for %s (Docling pipeline should be used)", file_path.name)
        return ""

    async def _extract_image_text(self, file_path: Path) -> str:
        """
        Fallback image text extraction (used only when vision pipeline is unavailable).
        Tests may patch this hook.
        """
        logger.warning("Image text extraction fallback called for %s (vision pipeline should be used)", file_path.name)
        return ""

    async def _extract_text(self, file_path: Path) -> str:
        try:
            return file_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return file_path.read_text(encoding="latin-1", errors="ignore")

    async def _extract_tables(self, file_path: Path) -> list:
        # Placeholder for rich document table extraction; tests patch this hook.
        return []

    def _validate_file_data(self, file_data: Dict[str, Any]) -> bool:
        """Validate file data structure."""
        required_fields = ["name", "base64"]
        return all(field in file_data and file_data[field] for field in required_fields)

    async def _send_processing_start_message(
        self, interpreter: Any, file_name: str, prompt: str, request_id: str
    ) -> None:
        """Send processing start message to UI."""
        try:
            interpreter.display_message(
                {
                    "role": "computer",
                    "type": "code",
                    "content": (
                        "# Centralized Docling File Processing\n\n"
                        f"File: {file_name}\n"
                        f"Prompt: {prompt[:100]}...\n\n"
                        "Using centralized Docling service with smart configuration...\n"
                    ),
                    "format": "markdown",
                    "request_id": request_id,
                }
            )
        except Exception as e:  # noqa: BLE001 -- WS message: best-effort, don't crash processing
            logger.warning("Failed to send processing start message: %s", e)

    async def _handle_success_result(
        self,
        result: Dict[str, Any],
        file_name: str,
        prompt: str,
        request_id: str,
        interpreter: Any,
    ) -> Dict[str, Any]:
        """Handle successful processing result."""
        try:
            # Extract result data
            processing_time = result.get("processing_time", 0)
            engine_used = result.get("engine_used", "unknown")
            pages_processed = result.get("pages_processed", 1)
            content = result.get("content", "")
            combined_prompt = result.get("combined_prompt")
            
            # Send processing results to code tab
            result_json = json.dumps(
                {
                    "success": True,
                    "content": content,
                    "format": result.get("format", "json"),
                    "engine_used": engine_used,
                    "processing_time": processing_time,
                    "pages_processed": pages_processed,
                    "file_info": result.get("file_info", {}),
                },
                indent=2,
            )
            
            interpreter.display_message(
                {
                    "role": "computer",
                    "type": "code",
                    "content": (
                        "# Docling Processing Complete ✅\n\n"
                        f"**File:** {file_name}\n"
                        f"**Engine:** {engine_used}\n"
                        f"**Time:** {processing_time:.2f}s\n"
                        f"**Pages:** {pages_processed}\n\n"
                        f"```json\n{result_json}\n```\n"
                    ),
                    "format": "markdown",
                    "request_id": request_id,
                }
            )
            
            # Send JSON content to artifacts
            interpreter.display_message(
                {
                    "role": "computer",
                    "type": "output",
                    "format": "json",
                    "content": content
                    if content.strip()
                    else '{"message": "No content extracted"}',
                }
            )
            
            # Send success message to chat
            interpreter.display_message(
                {
                    "role": "assistant",
                    "type": "message",
                    "content": (
                        "✅ **File processed successfully!**\n\n"
                        f"- **Engine:** {engine_used}\n"
                        f"- **Processing time:** {processing_time:.2f}s\n"
                        f"- **Pages:** {pages_processed}\n\n"
                        "Results are available in the artifacts window."
                    ),
                    "request_id": request_id,
                }
            )
            
            # Analyze with LLM if prompt provided
            if combined_prompt and prompt:
                await self._analyze_with_llm(interpreter, combined_prompt, request_id)
            
            return {
                "status": "ok",
                "request_id": request_id,
                "docling_result": result,
            }
            
        except Exception as e:  # noqa: BLE001 -- result handling boundary: must return error response, never crash
            logger.error("Error handling success result for request %s: %s", request_id, e, exc_info=True)
            return self._create_error_response(
                "Result handling failed. Check server logs for details.", request_id
            )

    async def _handle_error_result(
        self,
        result: Dict[str, Any],
        file_name: str,
        request_id: str,
        interpreter: Any,
    ) -> Dict[str, Any]:
        """Handle processing error result."""
        error_msg = result.get("error", "Unknown processing error")
        
        logger.error("Docling processing failed: %s", error_msg)
        
        try:
            interpreter.display_message(
                {
                    "role": "server",
                    "type": "error",
                    "message": f"❌ Failed to process file: {error_msg}",
                    "request_id": request_id,
                }
            )
        except Exception as e:  # noqa: BLE001 -- WS message: best-effort, don't crash error handling
            logger.warning("Failed to send error message: %s", e)
        
        return {
            "status": "error",
            "request_id": request_id,
            "error": error_msg,
        }

    async def _analyze_with_llm(
        self, interpreter: Any, combined_prompt: str, request_id: str
    ) -> None:
        """Send combined content to LLM for analysis."""
        try:
            await interpreter.chat(combined_prompt, stream=True)
        except Exception as e:  # noqa: BLE001 -- LLM chat boundary: must handle error, never crash
            logger.error("Error sending to LLM for request %s: %s", request_id, e, exc_info=True)
            try:
                interpreter.display_message(
                    {
                        "role": "server",
                        "type": "error",
                        "message": "Error analyzing with LLM. Check server logs for details.",
                        "request_id": request_id,
                    }
                )
            except Exception as inner_e:  # noqa: BLE001 -- inner WS message: best-effort
                logger.debug("Failed to send LLM error message: %s", inner_e)

    async def _send_error_message(
        self, interpreter: Any, error_msg: str, request_id: str
    ) -> None:
        """Send error message to UI."""
        try:
            interpreter.display_message(
                {
                    "role": "server",
                    "type": "error",
                    "message": f"Failed to process file: {error_msg}",
                    "request_id": request_id,
                }
            )
        except Exception:  # noqa: BLE001 -- WS error send: best-effort, client may be disconnected
            logger.debug("Failed to send error to UI (client may be disconnected)")

    def _create_error_response(self, message: str, request_id: str) -> Dict[str, Any]:
        """Create standardized error response."""
        return {
            "status": "error",
            "message": message,
            "request_id": request_id,
        }

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get health status of document processor.
        
        Returns:
            Dict with health status information
        """
        try:
            from core.integrations.providers.docling import docling_health
            docling_status = docling_health()
        except Exception as exc:  # noqa: BLE001 -- health check must always return
            logger.warning("Docling health check failed: %s", exc)
            docling_status = {"status": "error", "error": "Health check failed"}
        return {
            "docling": docling_status,
            "config_manager_available": self._config_manager is not None,
            "request_tracker_available": self._request_tracker is not None,
        }


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value
