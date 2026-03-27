"""
Omni Application Service

Coordinates screenshot capture and screen analysis for agent consumption.

IMPORTANT:
- Omni (screen tools) is for screen analysis and structured agent-facing output.
- Docling is for document parsing/conversion.
- Do not duplicate doc parsing responsibilities here.

@.architecture
Incoming: api/v1/endpoints/omni.py --- {Omni API payloads, Dict[str, Any]}
Processing: capture_screenshot(), analyze_screen(), get_workflows() --- {3 jobs: JOB_IO_SCREENSHOT, JOB_VISION_ANALYZE, JOB_TEMPLATE_LIST}
Outgoing: core/integrations/libraries/omni/tools.py --- {Omni workflow metadata, screen analysis results}
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import httpx

from config.settings import get_settings
from monitoring import get_logger

logger = get_logger(__name__)


class OmniServiceError(RuntimeError):
    """Raised when Omni service operations fail."""


class OmniService:
    """Facade bridging HTTP endpoints with Omni screen tooling."""

    def __init__(self, omni_tools: Any) -> None:
        # Tools are injected by the API layer to avoid application_services importing integrations.
        self._omni_tools = omni_tools

    async def _analyze_image_with_configured_vision_llm(self, *, prompt: str, base64_png: str) -> str:
        """
        Analyze an image using the resolved vision per-service provider.
        
        Resolution chain (via vision_document.provider_config):
          1. provider_config.model (GLM-OCR for OCR tasks)
          2. inference.default_vision_model (LFM VL for general vision)
        
        Contract:
        - Uses per-service provider resolution.
        - Fails fast if provider/model is not configured or request fails.
        """
        settings = get_settings()
        
        # Resolve via per-service provider
        provider_url, model, api_key = settings.resolve_service_provider(
            settings.vision_document.provider_config, service_type="vision"
        )

        if not provider_url or not isinstance(provider_url, str) or not provider_url.strip():
            raise OmniServiceError(
                "Vision provider URL not resolved. Check vision_document.provider_config or inference settings."
            )
        if not model or not isinstance(model, str) or not model.strip():
            raise OmniServiceError(
                "Vision model not resolved. Set inference.default_vision_model or vision_document.provider_config.model."
            )
        if not base64_png or not isinstance(base64_png, str) or not base64_png.strip():
            raise OmniServiceError("No screenshot image data provided for analysis.")

        payload: Dict[str, Any] = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_png}"}},
                    ],
                }
            ],
            "temperature": settings.inference.get_agent_generation_params("ocr")["temperature"],
            "max_tokens": settings.inference.get_agent_generation_params("ocr")["max_tokens"],
            "stream": False,
        }

        # Build headers — skip Bearer for aether-inference ("not-needed")
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if api_key and api_key != "not-needed":
            headers["Authorization"] = f"Bearer {api_key}"

        # Use the same timeout strategy as LLM proxy (bounded, not infinite).
        timeout = float(settings.http_client.llm_timeout) * 2
        limits = httpx.Limits(max_keepalive_connections=5, max_connections=10, keepalive_expiry=30.0)

        try:
            async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
                resp = await client.post(
                    f"{provider_url.rstrip('/')}/chat/completions",
                    json=payload,
                    headers=headers,
                )
        except httpx.TimeoutException as exc:
            raise OmniServiceError("Vision analysis timed out calling vision provider.") from exc
        except httpx.RequestError as exc:
            raise OmniServiceError(f"Vision analysis failed to connect to vision provider: {exc}") from exc

        if resp.status_code != 200:
            raise OmniServiceError(
                f"Vision analysis failed (status={resp.status_code}) using model={model}. "
                f"Check vision provider connectivity and model availability."
            )

        try:
            data = resp.json()
            choices = data.get("choices") or []
            message = choices[0].get("message") if choices else None
            content = message.get("content") if isinstance(message, dict) else None
        except Exception as exc:
            raise OmniServiceError("Vision analysis returned invalid JSON from provider.") from exc

        if not content or not isinstance(content, str):
            raise OmniServiceError("Vision analysis returned empty content from provider.")

        return content

    async def capture_screenshot(self, save_path: Optional[str]) -> Dict[str, Any]:
        result = await asyncio.to_thread(self._omni_tools.screenshot, save_path)
        if not result.get("success"):
            raise OmniServiceError(result.get("error", "Screenshot capture failed"))
        logger.info("Omni screenshot captured")
        return result

    async def analyze_screen(self, prompt: str) -> Dict[str, Any]:
        # Capture screenshot (base64) and analyze via configured vision/LLM pipeline.
        screenshot = await self.capture_screenshot(save_path=None)
        base64_png = screenshot.get("base64")
        analysis = await self._analyze_image_with_configured_vision_llm(prompt=prompt, base64_png=base64_png)
        logger.info("Omni screen analysis complete")
        return {"success": True, "analysis": analysis, "screenshot_base64": base64_png}

    def get_workflows(self) -> Dict[str, Any]:
        return self._omni_tools.workflows()

    async def health(self) -> Dict[str, Any]:
        settings = get_settings()
        # Resolve actual vision model from per-service provider (same path as analysis)
        _, vision_model, _ = settings.resolve_service_provider(
            settings.vision_document.provider_config, service_type="vision"
        )
        provider_name = settings.vision_document.provider_config.provider or "aether_inference"
        return {
            "healthy": True,
            "workflows": len(self.get_workflows()),
            "capabilities": {
                "screenshot": True,
                "screen_analysis": bool(vision_model),
                "vision_model": vision_model,
                "provider": provider_name,
            },
        }

    async def shutdown(self) -> None:
        return None




    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
