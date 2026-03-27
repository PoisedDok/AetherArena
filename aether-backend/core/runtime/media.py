"""
Runtime Media Service

Wraps DocumentProcessor for runtime coordinator, providing file chat and multipart processing.
Coordinates document analysis and artifact preparation.

@.architecture
Incoming: core/runtime/coordinator.py --- {file_data, prompt, request_id}
Processing: process_file_chat(), process_file_chat_multipart(), initialize() --- {2 jobs: JOB_ORCHESTRATE, JOB_TRANSFORM_DATA}
Outgoing: core/runtime/document.py, ws/handlers.py --- {Dict[str, Any]}
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class RuntimeMediaService:
    """
    Wraps DocumentProcessor responsibilities for runtime coordinator.
    """

    def __init__(self) -> None:
        self._document_processor: Optional[Any] = None

    async def initialize(self, config_manager: Any, request_tracker: Any) -> None:
        if self._document_processor:
            return
        if not config_manager or not request_tracker:
            raise RuntimeError("DocumentProcessor requires config manager and request tracker")
        from .document import DocumentProcessor

        self._document_processor = DocumentProcessor(config_manager, request_tracker)
        logger.debug("Document processor initialized via RuntimeMediaService")

    async def process_file_chat(
        self,
        *,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
        interpreter: Optional[Any] = None,
    ) -> Dict[str, Any]:
        if not self._document_processor:
            raise RuntimeError("Document processor not initialized")
        return await self._document_processor.process_file_chat(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def process_file_chat_multipart(
        self,
        *,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
        interpreter: Optional[Any] = None,
    ) -> Dict[str, Any]:
        if not self._document_processor:
            raise RuntimeError("Document processor not initialized")
        return await self._document_processor.process_file_chat_multipart(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def cleanup(self) -> None:
        if self._document_processor and hasattr(self._document_processor, "cleanup"):
            await self._document_processor.cleanup()
        self._document_processor = None

    def get_health_status(self) -> Dict[str, Any]:
        return {
            "available": self._document_processor is not None,
            "details": getattr(self._document_processor, "get_health_status", lambda: {})(),
        }


