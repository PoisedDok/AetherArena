"""
Document Processor - File processing and analysis
Consolidated from document_processor.py and file_chat_processor.py

@.architecture
Incoming: core/runtime/engine.py --- {file paths, file data, user prompts, Docling API URL}
Processing: process_file_chat(), _convert_with_docling(), _build_combined_prompt(), _run_llm_analysis() --- {4 jobs: file_validation, document_conversion, prompt_generation, llm_integration}
Outgoing: Docling API (HTTP POST), core/runtime/interpreter.py --- {HTTP POST to /convert with multipart file upload, AsyncGenerator[Dict] LLM response chunks}

Handles:
- Document conversion using Docling API
- SmolDocling for PDF processing with OCR
- InternVL for image analysis
- File upload validation and processing
- LLM analysis integration
- UI feedback and progress tracking
- Combined prompt generation

Production Features:
- Proper pipeline selection based on file type
- High accuracy OCR and VLM settings
- Complete error handling
- UI feedback through interpreter
- Processing time tracking
- Multipart file upload support

"""

import base64
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class DocumentProcessor:
    """
    Processes documents and files with Docling API and LLM analysis.
    
    Features:
    - SmolDocling for PDF processing with advanced OCR
    - InternVL for high-quality image analysis  
    - Standard pipeline for other document types
    - File upload validation and processing
    - LLM integration for document analysis
    - Progress tracking and UI feedback
    - Combined prompt generation for context
    
    Supported File Types:
    - PDFs (via SmolDocling with OCR)
    - Images (via InternVL)
    - Other documents (via standard Docling pipeline)
    """

    def __init__(self, config_manager, request_tracker):
        """
        Initialize document processor.
        
        Args:
            config_manager: Config manager for HTTP client access
            request_tracker: Request tracker for cancellation support
        """
        self._config_manager = config_manager
        self._request_tracker = request_tracker
        self._docling_url = "http://localhost:8000/convert"

    # ============================================================================
    # DOCUMENT CONVERSION
    # ============================================================================

    async def process_file(
        self, base64_data: str, filename: str, user_prompt: str = ""
    ) -> Dict[str, Any]:
        """
        Process a file using Docling API with smart pipeline selection.
        
        Args:
            base64_data: Base64 encoded file content
            filename: Original filename
            user_prompt: Optional user prompt for analysis
            
        Returns:
            Dict with processing results or error information
        """
        try:
            # Determine optimal pipeline based on file type
            pipeline_config = self._get_pipeline_config(filename)
            
            # Prepare API request
            payload = self._build_api_payload(pipeline_config, user_prompt)
            
            # Convert base64 to file content
            file_content = base64.b64decode(base64_data)
            
            # Prepare multipart form data
            data_fields = {k: str(v) for k, v in payload.items() if v is not None}
            files = {"file": (filename, file_content, "application/octet-stream")}
            
            # Make API call
            async with self._config_manager.client_context() as client:
                response = await client.post(
                    self._docling_url,
                    data=data_fields,
                    files=files,
                )
            
            # Process response
            if response.status_code == 200:
                result = response.json()
                return self._build_success_response(result, user_prompt, filename)
            else:
                error_text = response.text
                return self._build_error_response(
                    f"Docling API error ({response.status_code}): {error_text}"
                )
                
        except Exception as e:
            logger.error(f"Error processing file with Docling API: {e}")
            return self._build_error_response(
                f"Failed to process with Docling API: {str(e)}"
            )

    def _get_pipeline_config(self, filename: str) -> Dict[str, Any]:
        """Determine optimal pipeline configuration based on file type."""
        file_ext = Path(filename).suffix.lower()
        
        if file_ext == ".pdf":
            # Force SmolDocling for PDFs
            logger.info(
                f"Using SmolDocling pipeline for {filename} - "
                "Advanced PDF analysis with OCR"
            )
            return {
                "pipeline": "vlm",
                "vlm_model": "smoldocling",
                "lm_studio_model": "smoldocling-256m-preview-mlx",
                "ocr_engine": "ocrmac",
                "output_format": "doctags",
            }
        elif file_ext in [".jpg", ".jpeg", ".png", ".tiff", ".bmp"]:
            # Force InternVL for images
            logger.info(
                f"Using InternVL pipeline for {filename} - "
                "High-quality image analysis"
            )
            return {
                "pipeline": "vlm",
                "vlm_model": "internvl",
                "lm_studio_model": "internvl3_5-2b",
                "output_format": "markdown",
            }
        else:
            # Standard pipeline for other files
            return {
                "pipeline": "standard",
                "ocr_engine": "ocrmac",
                "output_format": "markdown",
            }

    def _build_api_payload(
        self, config: Dict[str, Any], user_prompt: str
    ) -> Dict[str, Any]:
        """Build API payload with high accuracy settings."""
        return {
            "pipeline": config["pipeline"],
            "ocr_engine": config.get("ocr_engine", "ocrmac"),
            "vlm_model": config.get("vlm_model"),
            "output_format": config["output_format"],
            "lm_studio_url": "http://localhost:1234/v1/chat/completions",
            "lm_studio_model": config.get("lm_studio_model"),
            "enable_code_enrichment": True,
            "enable_formula_enrichment": True,
            "enable_picture_classification": True,
            "enable_picture_description": True,
            "ocr_languages": "en",
        }

    def _build_success_response(
        self, api_result: Dict[str, Any], user_prompt: str, filename: str
    ) -> Dict[str, Any]:
        """Build success response with processed content."""
        content = api_result.get("content", "")
        combined_prompt = self._create_combined_prompt(content, user_prompt, filename)
        
        return {
            "success": True,
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
        await self._request_tracker.start_request(request_id, "file_processor", prompt)
        
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
                
        except Exception as e:
            import traceback
            error_msg = f"File processing error: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            
            # Send error message to UI
            await self._send_error_message(interpreter, error_msg, request_id)
            
            return self._create_error_response(error_msg, request_id)
            
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
        await self._request_tracker.start_request(request_id, "file_processor", prompt)
        
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
                
        except Exception as e:
            import traceback
            error_msg = f"Multipart file processing error: {str(e)}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            
            await self._send_error_message(interpreter, error_msg, request_id)
            return self._create_error_response(error_msg, request_id)
            
        finally:
            # Clean up request tracking
            await self._request_tracker.end_request(request_id)

    # ============================================================================
    # HELPER METHODS
    # ============================================================================

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
                    "id": request_id,
                }
            )
        except Exception as e:
            logger.warning(f"Failed to send processing start message: {e}")

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
                    "id": request_id,
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
                    "id": request_id,
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
            
        except Exception as e:
            logger.error(f"Error handling success result: {e}")
            return self._create_error_response(
                f"Result handling failed: {str(e)}", request_id
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
        
        logger.error(f"Docling processing failed: {error_msg}")
        
        try:
            interpreter.display_message(
                {
                    "role": "server",
                    "type": "error",
                    "message": f"❌ Failed to process file: {error_msg}",
                    "id": request_id,
                }
            )
        except Exception as e:
            logger.warning(f"Failed to send error message: {e}")
        
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
        except Exception as e:
            logger.error(f"Error sending to LLM: {e}")
            try:
                interpreter.display_message(
                    {
                        "role": "server",
                        "type": "error",
                        "message": f"Error analyzing with LLM: {str(e)}",
                        "id": request_id,
                    }
                )
            except Exception as inner_e:
                logger.debug(f"Failed to send LLM error: {inner_e}")

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
                    "id": request_id,
                }
            )
        except Exception:
            pass  # UI might not be available

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
        return {
            "docling_url": self._docling_url,
            "config_manager_available": self._config_manager is not None,
            "request_tracker_available": self._request_tracker is not None,
        }

