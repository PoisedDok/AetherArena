"""
OmniParser Integration - Layer 1 Implementation

Provides vision and document parsing tools using OmniParser capabilities.

Features:
- Screenshot capture and analysis
- Screen analysis via vision models
- Document parsing with multiple OCR engines
- Batch document discovery and parsing
- Workflow templates

Production-ready with:
- Error handling
- Multi-threading for parallel OCR
- Result reconciliation
- Vision model integration fallback

@.architecture
Incoming: api/v1/endpoints/omni.py, Open Interpreter computer --- {str screen_region, str file_path, List[str] ocr_engines, Dict analysis config}
Processing: omni_capture_screenshot(), omni_analyze_screen(), omni_parse_document(), omni_multi_ocr_parse() --- {4 jobs: document_parsing, multi_ocr_orchestration, screenshot_capture, vision_analysis}
Outgoing: api/v1/endpoints/omni.py --- {Dict[str, Any] screenshot data, Dict[str, Any] analysis result, Dict[str, Any] parsed document}
"""

import base64
import io
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


@dataclass
class OCRResult:
    """OCR engine result container"""
    engine: str
    success: bool
    content: str
    confidence: float = 0.0
    error: Optional[str] = None


class OmniParalegalTools:
    """
    High-level paralegal utilities for vision and document processing.
    
    Integrates with Open Interpreter computer instance for full capabilities.
    """
    
    def __init__(self, computer: Any):
        """
        Initialize Omni tools with computer instance.
        
        Args:
            computer: Open Interpreter computer instance
        """
        self._computer = computer
        self._lock = threading.RLock()
        logger.debug("Initialized OmniParalegalTools")
    
    def screenshot(self, save_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Capture screenshot of current screen.
        
        Args:
            save_path: Optional path to save screenshot
            
        Returns:
            Dict with:
                - success: bool
                - path: str (if saved)
                - base64: str (if not saved)
                - error: str (if failed)
        """
        try:
            # Try using computer.display.screenshot if available
            if hasattr(self._computer, 'display') and hasattr(self._computer.display, 'screenshot'):
                result = self._computer.display.screenshot()
                
                if save_path:
                    # Save to file
                    from PIL import Image
                    img = Image.frombytes('RGB', result['size'], result['data'])
                    img.save(save_path)
                    logger.info(f"Screenshot saved to {save_path}")
                    return {"success": True, "path": save_path}
                else:
                    # Return base64
                    buffer = io.BytesIO()
                    from PIL import Image
                    img = Image.frombytes('RGB', result['size'], result['data'])
                    img.save(buffer, format='PNG')
                    base64_data = base64.b64encode(buffer.getvalue()).decode()
                    return {"success": True, "base64": base64_data}
            else:
                # Fallback to platform-specific screenshot
                try:
                    from PIL import ImageGrab
                    img = ImageGrab.grab()
                    
                    if save_path:
                        img.save(save_path)
                        logger.info(f"Screenshot saved to {save_path}")
                        return {"success": True, "path": save_path}
                    else:
                        buffer = io.BytesIO()
                        img.save(buffer, format='PNG')
                        base64_data = base64.b64encode(buffer.getvalue()).decode()
                        return {"success": True, "base64": base64_data}
                except ImportError:
                    return {"success": False, "error": "PIL/Pillow not available for screenshot"}
                    
        except Exception as e:
            error_msg = f"Screenshot failed: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def analyze_screen(self, prompt: str = "Describe this screen.") -> Dict[str, Any]:
        """
        Analyze current screen using vision model.
        
        Args:
            prompt: Analysis prompt
            
        Returns:
            Dict with:
                - success: bool
                - analysis: str
                - error: str (if failed)
        """
        try:
            # Capture screenshot
            screenshot_result = self.screenshot()
            
            if not screenshot_result.get("success"):
                return {"success": False, "error": "Screenshot capture failed"}
            
            # Get base64 image
            base64_image = screenshot_result.get("base64")
            if not base64_image:
                return {"success": False, "error": "No image data"}
            
            # Try using vision agent if available
            if hasattr(self._computer, 'agents') and hasattr(self._computer.agents, 'vision'):
                analysis = self._computer.agents.vision.analyze(base64_image, prompt)
                logger.info("Screen analysis completed")
                return {"success": True, "analysis": analysis}
            else:
                # Fallback: use LLM with vision capability if available
                return {
                    "success": False,
                    "error": "Vision analysis not available. Requires vision agent or VLM."
                }
                
        except Exception as e:
            error_msg = f"Screen analysis failed: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def parse_document(
        self,
        file_path: str,
        output_format: str = "doctags"
    ) -> Dict[str, Any]:
        """
        Parse document using Docling service (smart conversion).
        
        Args:
            file_path: Path to document
            output_format: Output format (doctags, markdown, json)
            
        Returns:
            Dict with parsing results
        """
        try:
            # Use computer.docling if available
            if hasattr(self._computer, 'docling'):
                result = self._computer.docling.convert(
                    file_path=file_path,
                    output_format=output_format
                )
                logger.info(f"Parsed document: {file_path}")
                return result
            else:
                return {
                    "success": False,
                    "error": "Docling service not available. Ensure docling integration is loaded."
                }
                
        except Exception as e:
            error_msg = f"Document parsing failed: {str(e)}"
            logger.error(error_msg)
            return {"success": False, "error": error_msg}
    
    def multi_ocr_parse(
        self,
        file_path: str,
        engines: Optional[List[str]] = None,
        output_format: str = "doctags",
        include_image_analysis: bool = True
    ) -> Dict[str, Any]:
        """
        Run multiple OCR engines in parallel and reconcile results.
        
        Args:
            file_path: Path to document
            engines: OCR engines to use (default: ["ocrmac", "easyocr", "rapidocr"])
            output_format: Output format
            include_image_analysis: Include vision model analysis for images
            
        Returns:
            Dict with:
                - file: str
                - engines: list of engines used
                - results: list of individual results
                - reconciled: best result
                - vision: vision analysis (if image and enabled)
                - error: str (if failed)
        """
        if engines is None:
            engines = ["ocrmac", "easyocr", "rapidocr"]
        
        try:
            path = Path(file_path)
            ext = path.suffix.lower()
            
            # Optional vision analysis for images
            vision_result = None
            if include_image_analysis and ext in {".png", ".jpg", ".jpeg", ".bmp", ".tiff"}:
                try:
                    if hasattr(self._computer, 'agents') and hasattr(self._computer.agents, 'vision'):
                        vision_result = self._computer.agents.vision.analyze_image(str(path))
                        logger.debug(f"Vision analysis completed for {file_path}")
                except Exception as e:
                    logger.warning(f"Vision analysis failed: {e}")
                    vision_result = None
            
            # Run OCR engines in parallel
            results: List[OCRResult] = []
            with ThreadPoolExecutor(max_workers=min(4, len(engines))) as pool:
                futures = []
                for engine in engines:
                    futures.append(
                        pool.submit(
                            self._safe_docling_convert,
                            str(path),
                            engine,
                            output_format
                        )
                    )
                
                for future in as_completed(futures):
                    try:
                        result = future.result()
                        results.append(result)
                    except Exception as e:
                        logger.error(f"OCR engine failed: {e}")
            
            # Pick best result
            best = self._pick_best_content(results)
            
            logger.info(f"Multi-OCR parse complete: {len(results)} engines, best: {best.engine}")
            
            return {
                "file": str(path),
                "engines": [r.engine for r in results],
                "results": [
                    {
                        "engine": r.engine,
                        "success": r.success,
                        "content": r.content,
                        "confidence": r.confidence,
                        "error": r.error
                    }
                    for r in results
                ],
                "reconciled": {
                    "engine": best.engine,
                    "content": best.content,
                    "confidence": best.confidence
                },
                "vision": vision_result
            }
            
        except Exception as e:
            error_msg = f"Multi-OCR parsing failed: {str(e)}"
            logger.error(error_msg)
            return {"error": error_msg}
    
    def _safe_docling_convert(
        self,
        file_path: str,
        engine: str,
        output_format: str
    ) -> OCRResult:
        """
        Safely convert document with OCR engine.
        
        Args:
            file_path: Path to document
            engine: OCR engine name
            output_format: Output format
            
        Returns:
            OCRResult
        """
        try:
            if hasattr(self._computer, 'docling'):
                result = self._computer.docling.convert(
                    file_path=file_path,
                    ocr_engine=engine,
                    output_format=output_format
                )
                
                if result.get("success"):
                    content = result.get("content", "")
                    return OCRResult(
                        engine=engine,
                        success=True,
                        content=content,
                        confidence=len(content) / 1000.0  # Simple heuristic
                    )
                else:
                    return OCRResult(
                        engine=engine,
                        success=False,
                        content="",
                        error=result.get("error", "Unknown error")
                    )
            else:
                return OCRResult(
                    engine=engine,
                    success=False,
                    content="",
                    error="Docling service not available"
                )
                
        except Exception as e:
            return OCRResult(
                engine=engine,
                success=False,
                content="",
                error=str(e)
            )
    
    def _pick_best_content(self, results: List[OCRResult]) -> OCRResult:
        """
        Pick best OCR result based on confidence and content length.
        
        Args:
            results: List of OCR results
            
        Returns:
            Best OCRResult
        """
        if not results:
            return OCRResult(engine="none", success=False, content="", error="No results")
        
        # Filter successful results
        successful = [r for r in results if r.success]
        
        if not successful:
            # Return first result even if failed
            return results[0]
        
        # Pick result with highest confidence
        best = max(successful, key=lambda r: r.confidence)
        return best
    
    def find_and_parse_documents(
        self,
        query: str = "",
        paths: Optional[List[str]] = None,
        file_types: Optional[List[str]] = None,
        limit: int = 10,
        mode: str = "robust",
        output_format: str = "doctags"
    ) -> Dict[str, Any]:
        """
        Discover and parse documents in batch.
        
        Args:
            query: Search query for file content/name
            paths: Directories to search (default: ["./data/files"])
            file_types: File extensions to search (default: [".pdf", ".docx", ".txt"])
            limit: Maximum files to process
            mode: Processing mode (fast=convert_smart, robust=multi_ocr)
            output_format: Output format
            
        Returns:
            Dict with:
                - files_found: int
                - files_processed: int
                - results: list of parsing results
                - error: str (if failed)
        """
        if paths is None:
            paths = ["./data/files"]
        if file_types is None:
            file_types = [".pdf", ".docx", ".txt", ".png", ".jpg"]
        
        try:
            # Find files
            found_files = []
            for search_path in paths:
                path = Path(search_path)
                if not path.exists():
                    logger.warning(f"Path does not exist: {search_path}")
                    continue
                
                for file_type in file_types:
                    for file_path in path.rglob(f"*{file_type}"):
                        if query.lower() in file_path.name.lower():
                            found_files.append(str(file_path))
                        
                        if len(found_files) >= limit:
                            break
                    
                    if len(found_files) >= limit:
                        break
                
                if len(found_files) >= limit:
                    break
            
            logger.info(f"Found {len(found_files)} files matching criteria")
            
            # Process files
            results = []
            for file_path in found_files:
                if mode == "fast":
                    result = self.parse_document(file_path, output_format)
                else:  # robust
                    result = self.multi_ocr_parse(file_path, output_format=output_format)
                
                results.append({
                    "file": file_path,
                    "result": result
                })
            
            logger.info(f"Processed {len(results)} files")
            
            return {
                "files_found": len(found_files),
                "files_processed": len(results),
                "results": results
            }
            
        except Exception as e:
            error_msg = f"Batch processing failed: {str(e)}"
            logger.error(error_msg)
            return {"error": error_msg}
    
    def workflows(self) -> Dict[str, Any]:
        """
        Get available paralegal workflows with examples.
        
        Returns:
            Dict with workflow templates
        """
        return {
            "document_discovery": {
                "description": "Discover and parse legal documents in directory",
                "steps": [
                    "1. Search directories for document files",
                    "2. Parse each document with OCR",
                    "3. Extract key information",
                    "4. Generate summary report"
                ],
                "example": "find_and_parse_documents(query='contract', paths=['./data/legal'], file_types=['.pdf'])"
            },
            "screen_capture_analysis": {
                "description": "Capture and analyze screen content",
                "steps": [
                    "1. Capture current screen",
                    "2. Analyze with vision model",
                    "3. Extract relevant information",
                    "4. Return structured data"
                ],
                "example": "analyze_screen(prompt='Extract form fields from this screen')"
            },
            "multi_engine_ocr": {
                "description": "Use multiple OCR engines for best results",
                "steps": [
                    "1. Run document through multiple OCR engines",
                    "2. Reconcile results for accuracy",
                    "3. Include vision analysis if image",
                    "4. Return best result"
                ],
                "example": "multi_ocr_parse('document.pdf', engines=['ocrmac', 'easyocr', 'rapidocr'])"
            }
        }


# Convenience wrapper functions for direct use

def omni_screenshot(save_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Capture screenshot (convenience wrapper).
    
    Args:
        save_path: Optional path to save screenshot
        
    Returns:
        Dict with screenshot data
    """
    # This will be replaced by IntegrationLoader with proper computer instance
    return {"error": "Omni integration not loaded. Use via computer.omni.screenshot()"}


def omni_analyze_screen(prompt: str = "Describe this screen.") -> Dict[str, Any]:
    """
    Analyze screen (convenience wrapper).
    
    Args:
        prompt: Analysis prompt
        
    Returns:
        Dict with analysis
    """
    return {"error": "Omni integration not loaded. Use via computer.omni.analyze_screen()"}


def omni_parse_document(file_path: str, output_format: str = "doctags") -> Dict[str, Any]:
    """
    Parse document (convenience wrapper).
    
    Args:
        file_path: Path to document
        output_format: Output format
        
    Returns:
        Dict with parsing results
    """
    return {"error": "Omni integration not loaded. Use via computer.omni.parse_document()"}


def omni_multi_ocr_parse(
    file_path: str,
    engines: Optional[List[str]] = None,
    output_format: str = "doctags",
    include_image_analysis: bool = True
) -> Dict[str, Any]:
    """
    Multi-OCR parse (convenience wrapper).
    
    Args:
        file_path: Path to document
        engines: OCR engines
        output_format: Output format
        include_image_analysis: Include vision analysis
        
    Returns:
        Dict with results
    """
    return {"error": "Omni integration not loaded. Use via computer.omni.multi_ocr_parse()"}


def omni_find_and_parse_documents(
    query: str = "",
    paths: Optional[List[str]] = None,
    file_types: Optional[List[str]] = None,
    limit: int = 10,
    mode: str = "robust",
    output_format: str = "doctags"
) -> Dict[str, Any]:
    """
    Find and parse documents (convenience wrapper).
    
    Args:
        query: Search query
        paths: Directories
        file_types: File extensions
        limit: Max files
        mode: Processing mode
        output_format: Output format
        
    Returns:
        Dict with results
    """
    return {"error": "Omni integration not loaded. Use via computer.omni.find_and_parse_documents()"}


def omni_workflows() -> Dict[str, Any]:
    """Get workflows (convenience wrapper)."""
    # This one can work without computer instance
    tools = OmniParalegalTools(None)
    return tools.workflows()

