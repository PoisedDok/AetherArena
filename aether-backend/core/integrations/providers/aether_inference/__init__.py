"""
Aether Inference Provider - Core Integration Layer

Provides HTTP client for communicating with the aether-inference server
and GLM-OCR specific prompt adapters.

@.architecture
Incoming: api/v1/endpoints/*, core/integrations/libraries/ocr/*, docling/service.py --- {function calls}
Processing: client.py (OpenAI-compatible HTTP), glm_ocr.py (prompt formatting) --- {2 jobs: JOB_API_CALL, JOB_FORMAT_PROMPT}
Outgoing: aether-inference server via HTTP (port from central config) --- {OpenAI chat/completions, models list}
"""

from .client import InferenceClient, get_inference_client, inference_health
from .glm_ocr import GlmOcrAdapter

__all__ = [
    "InferenceClient",
    "get_inference_client",
    "inference_health",
    "GlmOcrAdapter",
]
