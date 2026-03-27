"""
@.architecture

Incoming: ws/presentation/handlers/message_handler.py, data/database/repositories/chat.py --- {chat_id, artifacts}
Processing: detect processing flags, route to vision/docling, format context --- {4 jobs: JOB_FILTER, JOB_HTTP_REQUEST, JOB_TRANSFORM_DATA, JOB_FORMAT_OUTPUT}
Outgoing: core/runtime/document.py (Docling in-process), InternVL API, interpreter system message --- {formatted_context, processed_artifacts}

Artifact Processor - Process uploaded artifacts based on metadata flags

Handles:
- Chat summaries: Extract and format for context injection
- Vision-required files: Send to InternVL for image analysis
- Docling-required files: Send to Docling for document extraction
- Generic files: Pass through content as-is
"""

import logging
import json
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ArtifactProcessor:
    """
    Processes artifacts based on metadata flags.
    
    Routes artifacts to appropriate services (Vision, Docling in-process)
    and formats output for context injection.
    """
    
    def __init__(
        self,
        *,
        document_processor: Optional[Any] = None,
    ):
        """
        Initialize artifact processor.
        
        Args:
            document_processor: Optional DocumentProcessor for Docling and InternVL
        """
        self._document_processor = document_processor
        self._logger = logger
    
    # ------------------------------------------------------------------
    # Shared budget-fitting (single path — no duplication)
    # ------------------------------------------------------------------

    def _fit_to_context_budget(
        self,
        text: str,
        filename: str,
        *,
        is_code: bool = False,
        max_context_tokens: int = 10_000,
    ) -> str:
        """Apply DocumentUtility extractive pipeline to fit text within LLM context budget.

        Small content that fits within budget is returned in full (zero signal loss).
        Large prose content is sentence-selected via LexRank; oversized code
        content falls back to head/tail line preservation.

        Args:
            text: Raw text content to budget-fit.
            filename: Source filename (used in output headers).
            is_code: Whether content should use code-aware extraction behavior.
            max_context_tokens: Token budget for this content.

        Returns:
            Budget-fitted text (may include [SKIPPED SECTION] markers).
        """
        try:
            from utils.document_processing import DocumentUtility
            util = DocumentUtility(max_context_tokens=max_context_tokens)
            result = util.extract_from_text(text, filename, is_code=is_code)
            return result or text
        except Exception as e:
            self._logger.warning(
                "DocumentUtility budget fitting failed for %s, keeping full text: %s",
                filename, e, exc_info=True
            )
            return text

    def _get_per_file_token_budget(self) -> int:
        """Derive per-file token budget from LLM context window (10%)."""
        try:
            from config.settings import get_settings
            settings = get_settings()
            return int(settings.llm.context_window * 0.10)
        except Exception as e:
            self._logger.error("Failed to load per-file token budget: %s", e, exc_info=True)
            return 10_000

    def _get_aggregate_token_budget(self) -> int:
        """Derive aggregate multi-file token budget from LLM context window (30%)."""
        try:
            from config.settings import get_settings
            settings = get_settings()
            return int(settings.llm.context_window * 0.30)
        except Exception as e:
            self._logger.error("Failed to load aggregate token budget: %s", e, exc_info=True)
            return 30_000

    async def process_artifacts(
        self,
        artifacts: List[Any],
        chat_id: str,
    ) -> Dict[str, Any]:
        """
        Process all artifacts and prepare context.
        
        Args:
            artifacts: List of artifact objects from database
            chat_id: Chat identifier
            
        Returns:
            Dictionary with:
                - context_text: Formatted context for injection
                - processed_count: Number of artifacts processed
                - vision_results: List of vision analysis results
                - docling_results: List of document extraction results
        """
        self._logger.info("Processing %d artifacts for chat %s", len(artifacts), chat_id[:8])
        
        context_parts = []
        vision_results = []
        docling_results = []
        processed_count = 0
        
        for artifact in artifacts:
            try:
                # Extract metadata
                metadata = artifact.metadata if hasattr(artifact, 'metadata') else {}
                if isinstance(metadata, str):
                    metadata = json.loads(metadata)
                
                is_chat_summary = metadata.get('is_chat_summary', False)
                requires_vision = metadata.get('requires_vision', False)
                requires_docling = metadata.get('requires_docling', False)
                
                # Route based on flags
                if is_chat_summary:
                    context = await self._process_chat_summary(artifact)
                    if context:
                        context_parts.append(context)
                        processed_count += 1
                
                elif requires_vision:
                    result = await self._process_vision_artifact(artifact)
                    if result:
                        vision_results.append(result)
                        context_parts.append(result['context'])
                        processed_count += 1
                
                elif requires_docling:
                    result = await self._process_docling_artifact(artifact)
                    if result:
                        docling_results.append(result)
                        context_parts.append(result['context'])
                        processed_count += 1
                
                else:
                    # Generic file - include content preview
                    context = self._process_generic_artifact(artifact)
                    if context:
                        context_parts.append(context)
                        processed_count += 1
                        
            except Exception as e:
                self._logger.error(
                    "Failed to process artifact %s: %s",
                    getattr(artifact, 'id', 'unknown'), e,
                    exc_info=True
                )
        
        # Format final context
        context_text = "\n\n".join(context_parts) if context_parts else ""
        
        # Aggregate context budget control: when multiple large files produce
        # combined context exceeding ~30% of LLM context window, apply
        # DocumentUtility extractive processing on the combined output.
        # This prevents multi-file attachment from blowing the context window.
        if context_text:
            try:
                aggregate_budget = self._get_aggregate_token_budget()
                # DocumentUtility uses ~5 chars/token internally
                budget_chars = aggregate_budget * 5
                if len(context_text) > budget_chars:
                    original_len = len(context_text)
                    context_text = self._fit_to_context_budget(
                        context_text, "combined_artifacts",
                        max_context_tokens=aggregate_budget,
                    )
                    self._logger.info(
                        "Aggregate artifact context fitted to budget: "
                        "%d -> %d chars (budget: %d tokens for %d files)",
                        original_len, len(context_text), aggregate_budget, processed_count,
                    )
            except Exception as e:
                self._logger.warning(
                    "Aggregate context budget fitting failed, keeping full combined context: %s", e, exc_info=True
                )
        
        self._logger.info(
            f"Processed {processed_count}/{len(artifacts)} artifacts for chat {chat_id[:8]}"
        )
        
        return {
            "context_text": context_text,
            "processed_count": processed_count,
            "vision_results": vision_results,
            "docling_results": docling_results,
        }
    
    async def _process_chat_summary(self, artifact: Any) -> Optional[str]:
        """
        Process chat summary artifact - extract and format.
        
        Args:
            artifact: Artifact object with summary content
            
        Returns:
            Formatted context string
        """
        try:
            content = artifact.content
            if not content:
                return None
            
            # Parse JSON summary
            if isinstance(content, str):
                summary_data = json.loads(content)
            else:
                summary_data = content
            
            chat_title = summary_data.get('chat_title', 'Untitled Chat')
            summary_text = summary_data.get('summary', '')
            key_topics = summary_data.get('key_topics', [])
            
            # Format for context injection
            context = f"""## 📝 Chat Summary: {chat_title}

{summary_text}"""
            
            if key_topics:
                context += f"\n\n**Key Topics:** {', '.join(key_topics)}"
            
            self._logger.debug("Processed chat summary: %s", chat_title)
            
            return context
            
        except Exception as e:
            self._logger.error("Failed to process chat summary: %s", e, exc_info=True)
            return None
    
    async def _process_vision_artifact(self, artifact: Any) -> Optional[Dict[str, Any]]:
        """
        Process vision-required artifact - send to InternVL via DocumentProcessor.
        
        Args:
            artifact: Artifact object with image content
            
        Returns:
            Dictionary with context and metadata
        """
        try:
            filename = getattr(artifact, 'filename', 'image.png')
            content = artifact.content
            
            if not self._document_processor:
                return {
                    'context': f"## 🖼️ Image Attached: {filename}\n[Image analysis not available]",
                    'filename': filename,
                    'status': 'pending'
                }
            
            # Decode base64 content if needed
            metadata = artifact.metadata if hasattr(artifact, 'metadata') else {}
            if isinstance(metadata, str):
                metadata = json.loads(metadata)
            
            is_binary = metadata.get('is_binary', False)
            
            if is_binary and content:
                self._logger.debug("Processing image with InternVL: %s", filename)
                
                # DocumentProcessor routes images to InternVL automatically
                result = await self._document_processor.process_file(
                    base64_data=content,
                    filename=filename,
                    user_prompt="Analyze this image and describe what you see."
                )
                
                analysis_text = result.get('text', '') or result.get('content', '') or result.get('analysis', '')
                
                if analysis_text:
                    budget = self._get_per_file_token_budget()
                    fitted = self._fit_to_context_budget(
                        analysis_text, filename, max_context_tokens=budget,
                    )
                    return {
                        'context': f"## 🖼️ Image Analysis: {filename}\n\n{fitted}",
                        'filename': filename,
                        'text': fitted,
                        'status': 'completed'
                    }
            
            return {
                'context': f"## 🖼️ Image: {filename}\n[Processing failed - no content]",
                'filename': filename,
                'status': 'failed'
            }
            
        except Exception as e:
            self._logger.error("Failed to process vision artifact: %s", e, exc_info=True)
            filename = getattr(artifact, 'filename', 'image')
            return {
                'context': f"## 🖼️ Image: {filename}\n[Processing error]",
                'filename': filename,
                'status': 'error'
            }
    
    async def _process_docling_artifact(self, artifact: Any) -> Optional[Dict[str, Any]]:
        """
        Process docling-required artifact.

        Binary content (PDF, DOCX, etc.) is routed through DocumentProcessor
        (Docling) for text extraction.  The extracted text is then budget-fitted
        via DocumentUtility.

        Defense-in-depth: if a text file incorrectly reaches this handler
        (e.g. .md with requires_docling=True due to stale metadata), the
        content is used directly without Docling extraction.

        Args:
            artifact: Artifact object with document content

        Returns:
            Dictionary with context and extracted text
        """
        try:
            filename = getattr(artifact, 'filename', 'document.pdf')

            content = artifact.content
            metadata = artifact.metadata if hasattr(artifact, 'metadata') else {}
            if isinstance(metadata, str):
                metadata = json.loads(metadata)

            is_binary = metadata.get('is_binary', False)
            extracted_text = None

            if is_binary and content:
                # Binary content — run Docling extraction first
                if not self._document_processor:
                    self._logger.warning("DocumentProcessor not available for %s", filename)
                    return {
                        'context': f"## 📄 Document Attached: {filename}\n[Document processing not available]",
                        'filename': filename,
                        'status': 'pending'
                    }

                self._logger.debug("Processing binary document with Docling: %s", filename)
                result = await self._document_processor.process_file(
                    base64_data=content,
                    filename=filename,
                    user_prompt=""
                )
                extracted_text = result.get('text', '') or result.get('content', '')

            elif not is_binary and content:
                # Text content that incorrectly reached Docling path
                # (defense-in-depth for .md/.txt with stale requires_docling flag).
                self._logger.info(
                    "Text content for %s reached Docling handler (is_binary=False); "
                    "using content directly",
                    filename,
                )
                extracted_text = str(content)

            if extracted_text:
                budget = self._get_per_file_token_budget()
                fitted = self._fit_to_context_budget(
                    extracted_text, filename, max_context_tokens=budget,
                )
                return {
                    'context': f"## 📄 Document Content: {filename}\n\n{fitted}",
                    'filename': filename,
                    'text': fitted,
                    'status': 'completed'
                }

            return {
                'context': f"## 📄 Document: {filename}\n[Processing failed - no content]",
                'filename': filename,
                'status': 'failed'
            }

        except Exception as e:
            self._logger.error("Failed to process docling artifact: %s", e, exc_info=True)
            filename = getattr(artifact, 'filename', 'document')
            return {
                'context': f"## 📄 Document: {filename}\n[Processing error]",
                'filename': filename,
                'status': 'error'
            }
    
    def _process_generic_artifact(self, artifact: Any) -> Optional[str]:
        """
        Process generic artifact — format content for LLM context.

        Applies DocumentUtility budget-fitting (Gate -> Split -> Score -> Select)
        to all text content regardless of size.  Small files pass through in full
        (zero signal loss); large files are intelligently extracted.

        Binary/base64 content that incorrectly reaches this path is detected
        via a whitespace-ratio heuristic and reported without extraction.

        Args:
            artifact: Artifact object

        Returns:
            Formatted context string
        """
        try:
            filename = getattr(artifact, 'filename', 'file.txt')
            content = artifact.content

            if not content:
                return None

            content_str = str(content)

            # Guard: detect binary/base64 content that reached generic path
            # due to missing or incorrect metadata flags.
            # Binary content is useless as text context — skip it.
            if len(content_str) > 500:
                sample = content_str[:2000]
                whitespace_ratio = sum(1 for c in sample if c in ' \t\n\r') / len(sample)
                if whitespace_ratio < 0.02:
                    self._logger.warning(
                        "Binary/base64 content detected for %s "
                        "(whitespace ratio: %.3f), skipping generic text extraction",
                        filename, whitespace_ratio,
                    )
                    return f"## 📎 File: {filename}\n\n[Binary file attached — {len(content_str):,} bytes]"

            # Determine if file is code (uses code-aware extraction path in DocumentUtility)
            code_extensions = {
                '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h',
                '.cs', '.go', '.rs', '.rb', '.php', '.css', '.json', '.yaml', '.yml',
                '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.sql',
            }
            is_code = any(filename.lower().endswith(ext) for ext in code_extensions)

            budget = self._get_per_file_token_budget()
            fitted = self._fit_to_context_budget(
                content_str, filename, is_code=is_code, max_context_tokens=budget,
            )
            return f"## 📎 File: {filename}\n\n```\n{fitted}\n```"

        except Exception as e:
            self._logger.error("Failed to process generic artifact: %s", e, exc_info=True)
            return None


# Singleton instance
_artifact_processor: Optional[ArtifactProcessor] = None


def get_artifact_processor() -> ArtifactProcessor:
    """Get or create artifact processor singleton."""
    global _artifact_processor
    if _artifact_processor is None:
        # Lazy import to avoid circular dependencies
        try:
            from core.runtime.document import DocumentProcessor
            document_processor = DocumentProcessor()
            logger.info("DocumentProcessor initialized for artifact processing")
        except Exception as e:
            logger.error("Failed to initialize DocumentProcessor: %s", e, exc_info=True)
            document_processor = None
        
        _artifact_processor = ArtifactProcessor(
            document_processor=document_processor
        )
    
    return _artifact_processor
