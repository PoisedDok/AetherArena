"""
GLM-OCR Prompt Adapter

Formats prompts per the GLM-OCR specification for document parsing and 
information extraction. Handles image encoding for the OpenAI-compatible API.

Reference: https://huggingface.co/zai-org/GLM-OCR

@.architecture
Incoming: ocr/glm_ocr_backend.py, docling/service.py --- {images, task type}
Processing: format_prompt(), encode_image(), parse_response() --- {3 jobs: JOB_FORMAT_PROMPT, JOB_ENCODE_IMAGE, JOB_PARSE_RESPONSE}
Outgoing: client.py --- {OpenAI-format messages with image content}
"""

import base64
import logging
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Union

logger = logging.getLogger(__name__)


class GLMOCRTask(str, Enum):
    """GLM-OCR supported task types."""
    TEXT = "text"
    FORMULA = "formula"
    TABLE = "table"
    INFO_EXTRACTION = "info_extraction"


# GLM-OCR prompt map (from official spec)
_TASK_PROMPTS = {
    GLMOCRTask.TEXT: "Text Recognition:",
    GLMOCRTask.FORMULA: "Formula Recognition:",
    GLMOCRTask.TABLE: "Table Recognition:",
}


class GlmOcrAdapter:
    """
    Adapter for GLM-OCR model prompts and response parsing.
    
    Formats requests per the GLM-OCR spec:
    - Document parsing: predefined task prompts ("Text Recognition:", etc.)
    - Information extraction: JSON schema prompts
    """
    
    @staticmethod
    def encode_image_to_base64_url(image_path: Union[str, Path]) -> str:
        """
        Encode a local image file to a base64 data URL for the OpenAI image_url content type.
        
        Args:
            image_path: Path to the image file
            
        Returns:
            Base64 data URL string (e.g. "data:image/png;base64,...")
        """
        path = Path(image_path)
        if not path.exists():
            raise FileNotFoundError(f"Image not found: {path}")
        
        # Determine MIME type from extension
        ext = path.suffix.lower()
        mime_map = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".tiff": "image/tiff",
            ".tif": "image/tiff",
            ".bmp": "image/bmp",
        }
        mime_type = mime_map.get(ext, "image/png")
        
        try:
            with open(path, "rb") as f:
                encoded = base64.b64encode(f.read()).decode("utf-8")
            
            return f"data:{mime_type};base64,{encoded}"
        except Exception as e:
            logger.error("Failed to encode image to base64", exc_info=True, extra={"path": str(path), "error": str(e)})
            raise
    
    @staticmethod
    def encode_image_bytes_to_base64_url(image_bytes: bytes, mime_type: str = "image/png") -> str:
        """
        Encode raw image bytes to a base64 data URL.
        
        Args:
            image_bytes: Raw image data
            mime_type: MIME type of the image
            
        Returns:
            Base64 data URL string
        """
        encoded = base64.b64encode(image_bytes).decode("utf-8")
        return f"data:{mime_type};base64,{encoded}"
    
    @staticmethod
    def format_recognition_messages(
        image_source: str,
        task: GLMOCRTask = GLMOCRTask.TEXT,
    ) -> List[Dict[str, Any]]:
        """
        Format messages for GLM-OCR document parsing (recognition tasks).
        
        Args:
            image_source: Either a base64 data URL or an HTTP(S) URL to the image
            task: Recognition task type (text, formula, table)
            
        Returns:
            OpenAI-format messages list
        """
        if task == GLMOCRTask.INFO_EXTRACTION:
            raise ValueError("Use format_extraction_messages() for info extraction tasks")
        
        prompt_text = _TASK_PROMPTS.get(task, _TASK_PROMPTS[GLMOCRTask.TEXT])
        
        return [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_source},
                    },
                    {
                        "type": "text",
                        "text": prompt_text,
                    },
                ],
            }
        ]
    
    @staticmethod
    def format_extraction_messages(
        image_source: str,
        json_schema: str,
    ) -> List[Dict[str, Any]]:
        """
        Format messages for GLM-OCR information extraction.
        
        The prompt must include a JSON schema defining the expected output structure.
        GLM-OCR will strictly follow this schema.
        
        Args:
            image_source: Either a base64 data URL or an HTTP(S) URL
            json_schema: JSON schema string defining expected extraction output
            
        Returns:
            OpenAI-format messages list
        """
        # GLM-OCR expects the schema as the text prompt
        prompt_text = f"请按下列JSON格式输出图中信息:\n{json_schema}"
        
        return [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": image_source},
                    },
                    {
                        "type": "text",
                        "text": prompt_text,
                    },
                ],
            }
        ]
    
    @staticmethod
    def parse_response(response: Dict[str, Any]) -> str:
        """
        Extract the text content from an OpenAI-format chat completion response.
        
        Args:
            response: Full chat completion response dict
            
        Returns:
            The generated text content
        """
        try:
            choices = response.get("choices", [])
            if not choices:
                logger.warning("GLM-OCR response has no choices")
                return ""
            
            message = choices[0].get("message", {})
            content = message.get("content", "")
            return content.strip()
            
        except (KeyError, IndexError, TypeError, AttributeError) as e:
            logger.error("Failed to parse GLM-OCR response: %s", e)
            return ""
    
    @staticmethod
    def get_default_model() -> str:
        """
        Get the platform-appropriate GLM-OCR model identifier.
        
        Delegates to platform detection to return the correct model
        for the current hardware (MLX 8-bit on Mac, full on CUDA, Ollama tag).
        """
        try:
            from services.aether_inference.platform_detector import detect_platform
            pinfo = detect_platform()
            return pinfo.glm_ocr_model
        except Exception as e:
            logger.warning("Failed to get default GLM-OCR model, using fallback: %s", e)
            # Safe fallback -- Ollama name
            return "glm-ocr"
