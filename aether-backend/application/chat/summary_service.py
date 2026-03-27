"""
Chat Summary Service

Generates LLM-powered summaries of chats with metadata extraction.
Delegates to backend LLM endpoint for generation.

@.architecture
Incoming: API endpoints, Agent tools --- {chat_id, summary_type}
Processing: fetch messages, call LLM, extract metadata, save summary --- {5 jobs: JOB_HTTP_REQUEST, JOB_MANAGE_STORAGE, JOB_ORCHESTRATE, JOB_QUERY_DB, JOB_TRANSFORM_DATA}
Outgoing: Backend LLM endpoint, Database --- {ChatSummary, LLM completion}
"""

from typing import List, Dict, Any, Optional
from uuid import UUID
import httpx
import json
import re

from data.database.uow import SupabaseUnitOfWork
from data.database.repositories.chat import ChatRepository
from config.settings import Settings
from monitoring import get_logger
from utils.document_processing import DocumentUtility

logger = get_logger(__name__)

class ChatSummaryService:
    """Service for generating and managing chat summaries."""
    
    def __init__(self, uow: SupabaseUnitOfWork, settings: Settings):
        self._uow = uow
        self._gateway = uow.gateway
        self._chat_repository = ChatRepository(self._gateway)
        self._settings = settings
        self._is_disposed = False
        
        # Resolve summary-specific provider from central config
        # Default chain: inference.default_text_model -> llm.summarizer_model -> llm.model
        api_base, model, api_key = settings.resolve_service_provider(
            settings.summary_service.provider_config, service_type="text"
        )
        self._llm_api_base = api_base.rstrip("/")
        self._llm_model = model
        self._llm_api_key = api_key
    
    async def generate_summary(
        self,
        chat_id: UUID,
        summary_type: str = "full",
        force_regenerate: bool = False
    ) -> Dict[str, Any]:
        """
        Generate a summary for a chat using LLM.
        """
        try:
            logger.info("Generating %s summary for chat %s", summary_type, chat_id)
            
            # Check if summary already exists
            if not force_regenerate:
                existing = await self._get_existing_summary(chat_id, summary_type)
                if existing:
                    logger.info("✅ Using existing summary")
                    return existing
            
            # Fetch chat messages
            messages = await self._fetch_chat_messages(chat_id)
            if not messages or len(messages) == 0:
                raise ValueError(f"Chat {chat_id} has no messages to summarize")
            
            message_count = len(messages)
            
            # Format messages for LLM (size-adaptive)
            conversation_text = self._format_messages_for_llm(messages)
            
            # Generate summary via backend LLM endpoint
            summary_data = await self._call_llm_for_summary(
                conversation_text,
                summary_type,
                message_count=message_count
            )
            
            # Save summary to database
            summary_record = await self._save_summary(
                chat_id,
                summary_type,
                summary_data
            )
            
            logger.info("Generated summary %s", summary_record["id"])
            return summary_record
        except Exception as e:
            logger.error("Failed to generate summary for chat %s: %s", chat_id, e, exc_info=True)
            raise
    
    async def get_summary(
        self,
        chat_id: UUID,
        summary_type: str = "full"
    ) -> Optional[Dict[str, Any]]:
        """
        Get existing summary for a chat.
        """
        try:
            return await self._get_existing_summary(chat_id, summary_type)
        except Exception as e:
            logger.error("Failed to get summary for chat %s: %s", chat_id, e, exc_info=True)
            raise
    
    async def list_summaries(self, chat_id: UUID) -> List[Dict[str, Any]]:
        """Get all summaries for a chat."""
        try:
            summaries = await self._chat_repository.list_chat_summaries(chat_id)
            return summaries or []
        except Exception as e:
            logger.error("Failed to list summaries for chat %s: %s", chat_id, e, exc_info=True)
            raise
    
    async def search_summaries(
        self,
        query_text: str,
        limit: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Search chat summaries using full-text search.
        """
        try:
            # Use config default if not specified
            limit = limit if limit is not None else self._settings.summary_service.default_search_limit
            
            logger.info("Searching summaries for: %s", query_text)
            
            result = await self._gateway.rpc(
                "search_chat_summaries",
                {
                    "p_query_text": query_text,
                    "p_match_count": limit
                }
            )
            
            return result or []
        except Exception as e:
            logger.error("Failed to search summaries: %s", e, exc_info=True)
            raise
    
    async def _get_existing_summary(
        self,
        chat_id: UUID,
        summary_type: str
    ) -> Optional[Dict[str, Any]]:
        """Get existing summary from database."""
        result = await self._gateway.select(
            "chat_summaries",
            filters={
                "chat_id": str(chat_id),
                "summary_type": summary_type
            },
            limit=1
        )
        
        return result[0] if result and len(result) > 0 else None
    
    async def _fetch_chat_messages(
        self,
        chat_id: UUID
    ) -> List[Dict[str, Any]]:
        """Fetch all messages for a chat."""
        result = await self._gateway.select(
            "messages",
            filters={"chat_id": str(chat_id)}
        )
        
        # Sort by created_at in Python (Supabase select doesn't support order_by directly)
        if result:
            result.sort(key=lambda msg: msg.get("created_at", ""))
        
        return result or []
    
    # =========================================================================
    # Size-adaptive message formatting
    # =========================================================================

    def _classify_chat_size(self, message_count: int) -> str:
        """
        Classify chat size for adaptive summarization strategy.
        
        Returns: 'small' | 'medium' | 'large' | 'xlarge'
        """
        cfg = self._settings.summary_service
        if message_count <= cfg.small_chat_threshold:
            return "small"
        elif message_count <= cfg.medium_chat_threshold:
            return "medium"
        elif message_count <= cfg.large_chat_threshold:
            return "large"
        return "xlarge"

    def _format_single_message(self, msg: Dict[str, Any], include_timestamp: bool = False) -> str:
        """Format one message into a readable line with optional timestamp."""
        role = msg.get("role", "unknown").upper()
        content = (msg.get("content") or "").strip()
        if not content:
            return ""
        if include_timestamp:
            ts = msg.get("created_at", "")
            if ts:
                # Trim to minute precision for readability
                ts_short = str(ts)[:16]
                return f"[{ts_short}] {role}: {content}"
        return f"{role}: {content}"

    def _format_all_messages(self, messages: List[Dict[str, Any]], include_timestamp: bool = False) -> str:
        """Format all messages into a single text block (no truncation)."""
        lines = []
        for msg in messages:
            line = self._format_single_message(msg, include_timestamp=include_timestamp)
            if line:
                lines.append(line)
        return "\n\n".join(lines)

    def _extract_via_document_utility(self, full_text: str, message_count: int) -> str:
        """
        Use DocumentUtility's LexRank extractive pipeline to select the
        most topically important sentences from a large conversation.

        No truncation, no blocking.  LexRank graph centrality surfaces
        the highest-signal sentences.
        """
        cfg = self._settings.summary_service
        doc_util = DocumentUtility(
            max_context_tokens=cfg.max_conversation_chars // 5,
            target_sentences=30,
        )

        # Run the unified extractive pipeline. The gate inside extract_from_text
        # returns full text if it fits within max_context_tokens (zero loss), or
        # applies LexRank sentence extraction otherwise.
        result = doc_util.extract_from_text(full_text, f"conversation_{message_count}msgs")

        if not result:
            logger.warning("DocumentUtility extraction yielded nothing; returning raw text")
            return full_text

        extracted = result
        logger.info(
            "DocumentUtility extracted %d chars for %d-message chat",
            len(extracted), message_count,
        )
        return extracted

    def _format_messages_for_llm(
        self,
        messages: List[Dict[str, Any]]
    ) -> str:
        """
        Size-adaptive message formatting for LLM summarization.
        
        Strategy by chat size:
        - small  (1-5 msgs):   Full messages with timestamps. Every message matters.
        - medium (6-30 msgs):  Full messages, no timestamps. Complete conversation.
        - large  (31-100 msgs): Full text fed through DocumentUtility extractive pipeline.
                                 LexRank sentence ranking surfaces highest-signal content.
        - xlarge (100+ msgs):  Same DocumentUtility pipeline (scales to any size).
        
        No hard truncation. Large conversations are handled by intelligent extraction.
        """
        count = len(messages)
        size = self._classify_chat_size(count)

        logger.info("Formatting %d messages (size=%s)", count, size)

        if size == "small":
            # Full conversation with timestamps - every message matters
            return self._format_all_messages(messages, include_timestamp=True)

        elif size == "medium":
            # Full conversation without timestamps - complete context
            return self._format_all_messages(messages, include_timestamp=False)

        else:
            # large / xlarge: use DocumentUtility extractive pipeline
            # First, format ALL messages into full text (no truncation here)
            full_text = self._format_all_messages(messages, include_timestamp=False)
            # Then run through LexRank sentence extraction
            return self._extract_via_document_utility(full_text, count)

    # =========================================================================
    # Plain text fallback parser
    # =========================================================================

    def _parse_plain_text_summary(self, text: str) -> Dict[str, Any]:
        """
        Parse plain text summary into structured format.
        Fallback for models that don't return valid JSON.
        """
        lines = text.strip().split("\n")
        non_empty = [l.strip() for l in lines if l.strip()]
        
        title_max = self._settings.summary_service.title_max_length
        key_points_max = self._settings.summary_service.key_points_max
        fallback_length = self._settings.summary_service.fallback_content_length
        
        # First non-empty line as title
        title = non_empty[0] if non_empty else "Conversation Summary"
        # Strip common prefixes the LLM might prepend
        for prefix in ("Title:", "title:", "Summary:", "summary:", "#"):
            if title.startswith(prefix):
                title = title[len(prefix):].strip()
        
        # Extract bullet points
        key_points = []
        summary_lines = []
        for line in non_empty[1:]:
            stripped = line.strip()
            if stripped.startswith(("-", "*", "•", "1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.")):
                point = stripped.lstrip("-*•0123456789. ")
                if point:
                    key_points.append(point)
            elif stripped and not key_points:
                summary_lines.append(stripped)
        
        summary_prose = " ".join(summary_lines)[:fallback_length] if summary_lines else ""
        
        return {
            "title": title[:title_max],
            "summary": summary_prose or text[:fallback_length],
            "key_points": key_points[:key_points_max] if key_points else [text[:fallback_length]],
            "entities": {},
            "topics": []
        }

    # =========================================================================
    # LLM call with adaptive prompt construction
    # =========================================================================

    def _get_type_instruction(self, summary_type: str, chat_size: str) -> str:
        """Build detailed per-type instruction based on summary type and chat size."""
        # Size-adaptive key point guidance
        if chat_size == "small":
            point_hint = "For this short conversation, 1-3 key points are sufficient."
        elif chat_size == "medium":
            point_hint = "Cover the main discussion threads and any decisions reached."
        elif chat_size == "large":
            point_hint = "This is a long conversation with relevance-ranked sections. Focus on the most important themes, decisions, and outcomes."
        else:
            point_hint = "This is a very long conversation with relevance-ranked extracts. Infer the overall arc and major themes from what is shown."

        if summary_type == "brief":
            return (
                f"BRIEF SUMMARY MODE: Produce a short summary (2-3 sentences in the 'summary' field). "
                f"Limit key_points to 3 maximum. {point_hint}"
            )
        elif summary_type == "technical":
            return (
                f"TECHNICAL SUMMARY MODE: Focus on technical details - code changes, architecture decisions, "
                f"tool/library choices, bugs discussed, solutions proposed, and implementation approaches. "
                f"Entities should emphasize technologies, languages, and frameworks. {point_hint}"
            )
        elif summary_type == "executive":
            return (
                f"EXECUTIVE SUMMARY MODE: Focus on outcomes, decisions, action items, and strategic implications. "
                f"Avoid technical jargon. Entities should emphasize people and organizations. "
                f"Key points should be actionable and results-oriented. {point_hint}"
            )
        else:  # full
            return (
                f"FULL SUMMARY MODE: Provide a comprehensive summary covering the entire scope of the conversation. "
                f"Include technical details where relevant, decisions made, open questions, and next steps. {point_hint}"
            )

    def _get_size_hint(self, message_count: int, chat_size: str) -> str:
        """Generate a contextual hint about conversation size for the LLM."""
        if chat_size == "small":
            return f"This is a short conversation ({message_count} messages). All messages are included."
        elif chat_size == "medium":
            return f"This is a medium-length conversation ({message_count} messages). All messages are included."
        elif chat_size == "large":
            return (
                f"This is a long conversation ({message_count} messages). "
                f"The most topically important sections were extracted using relevance ranking. "
                f"Some lower-relevance sections were omitted. Summarize based on what is shown."
            )
        return (
            f"This is a very long conversation ({message_count} messages). "
            f"The most topically important sections were extracted using relevance ranking. "
            f"Many sections were omitted. Focus on identifying the overarching themes and key outcomes "
            f"from the extracted content."
        )

    async def _call_llm_for_summary(
        self,
        conversation_text: str,
        summary_type: str,
        message_count: int = 0
    ) -> Dict[str, Any]:
        """
        Call backend LLM endpoint to generate summary.
        
        Constructs size-adaptive prompt and selects appropriate max_tokens
        based on summary type and conversation length.
        
        Returns parsed summary data with title, summary, key_points, entities, topics.
        """
        cfg = self._settings.summary_service
        chat_size = self._classify_chat_size(message_count)
        
        # Build per-type instruction
        instruction = self._get_type_instruction(summary_type, chat_size)
        
        # Build size hint for LLM context
        size_hint = self._get_size_hint(message_count, chat_size)

        # Build system prompt from template
        template = getattr(cfg, "system_prompt_template", "") or ""
        if not template.strip():
            raise ValueError("summary_service.system_prompt_template is empty (misconfiguration)")

        try:
            system_prompt = template.format(
                instruction=instruction,
                title_max_length=cfg.title_max_length,
                key_points_max=cfg.key_points_max,
                size_hint=size_hint,
            )
        except Exception as exc:
            raise ValueError(f"Invalid summary_service.system_prompt_template: {exc}") from exc
        
        # Adaptive max_tokens: brief gets fewer, large chats get more
        if summary_type == "brief":
            max_tokens = cfg.max_tokens_brief
        else:
            max_tokens = cfg.max_tokens
        
        logger.info(
            f"Calling LLM for {summary_type} summary "
            f"(chat_size={chat_size}, msgs={message_count}, max_tokens={max_tokens})"
        )
        
        try:
            # Use resolved per-service provider (aether-inference by default)
            headers = {"Content-Type": "application/json"}
            if self._llm_api_key and self._llm_api_key != "not-needed":
                headers["Authorization"] = f"Bearer {self._llm_api_key}"
            
            async with httpx.AsyncClient(timeout=self._settings.http_client.llm_timeout) as client:
                response = await client.post(
                    f"{self._llm_api_base}/chat/completions",
                    json={
                        "model": self._llm_model,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": conversation_text}
                        ],
                        "temperature": cfg.temperature,
                        "max_tokens": max_tokens
                    },
                    headers=headers,
                )
                
                if response.status_code != 200:
                    error_msg = f"LLM request failed: {response.status_code} - {response.text}"
                    logger.error(error_msg)
                    raise httpx.HTTPError(error_msg)
                
                completion = response.json()
                raw_content = completion["choices"][0]["message"]["content"]
                
                # Parse response: try JSON first, then strip markdown fences, then plain text
                summary_data = self._parse_llm_response(raw_content)
                
                # Normalize and validate the output structure
                summary_data = self._normalize_summary_data(summary_data, message_count)
                
                logger.info("LLM summary generated successfully")
                return summary_data
                
        except Exception as e:
            logger.error("Error calling LLM for summary: %s", e, exc_info=True)
            raise

    def _parse_llm_response(self, raw_content: str) -> Dict[str, Any]:
        """
        Parse LLM response content into structured dict.
        
        Attempts in order:
        1. Direct JSON parse
        2. Strip markdown code fences and parse JSON
        3. Fall back to plain text extraction
        """
        content = raw_content.strip()
        
        # Pre-processing: Strip <think>...</think> blocks (Qwen3 and similar models)
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        
        # Attempt 1: Direct JSON parse
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass
        
        # Attempt 2: Strip markdown code fences (```json ... ``` or ``` ... ```)
        if content.startswith("```"):
            lines = content.split("\n")
            # Remove first line (```json or ```) and last line (```)
            inner_lines = []
            started = False
            for line in lines:
                if not started:
                    if line.strip().startswith("```"):
                        started = True
                        continue
                elif line.strip() == "```":
                    break
                else:
                    inner_lines.append(line)
            
            if inner_lines:
                try:
                    return json.loads("\n".join(inner_lines))
                except json.JSONDecodeError:
                    pass
        
        # Attempt 3: Find JSON object within text via brace-depth scanning.
        # Iterate through every '{' and find its balanced '}' to handle
        # preamble text that may contain unrelated braces.
        search_from = 0
        while True:
            brace_start = content.find("{", search_from)
            if brace_start == -1:
                break
            # Scan forward to find the balanced closing brace
            depth = 0
            in_string = False
            escape_next = False
            brace_end = -1
            for i in range(brace_start, len(content)):
                ch = content[i]
                if escape_next:
                    escape_next = False
                    continue
                if ch == "\\":
                    if in_string:
                        escape_next = True
                    continue
                if ch == '"':
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        brace_end = i
                        break
            if brace_end > brace_start:
                candidate = content[brace_start:brace_end + 1]
                try:
                    parsed = json.loads(candidate)
                    # Only accept if it looks like our summary schema (has at least title or key_points)
                    if isinstance(parsed, dict) and ("title" in parsed or "key_points" in parsed or "summary" in parsed):
                        return parsed
                except json.JSONDecodeError:
                    pass
            # Try next '{' position
            search_from = brace_start + 1
        
        # Attempt 4: Plain text fallback
        logger.warning("LLM returned non-JSON content. Falling back to plain text parser.")
        return self._parse_plain_text_summary(content)

    def _normalize_summary_data(self, data: Dict[str, Any], message_count: int) -> Dict[str, Any]:
        """
        Normalize and validate the parsed summary data.
        
        Ensures all required fields exist with correct types and applies limits.
        Normalizes entities from flat array to categorized dict if needed.
        """
        cfg = self._settings.summary_service
        
        # Title: string, truncated
        title = str(data.get("title") or "Untitled Conversation").strip()
        if not title or title.lower() in ("untitled", "conversation", "chat", "summary"):
            title = "Untitled Conversation"
        title = title[:cfg.title_max_length]
        
        # Summary prose: string
        summary = str(data.get("summary") or "").strip()
        
        # Key points: list of strings, limited
        raw_points = data.get("key_points", [])
        if isinstance(raw_points, list):
            key_points = [str(p).strip() for p in raw_points if str(p).strip()][:cfg.key_points_max]
        else:
            key_points = [str(raw_points).strip()] if str(raw_points).strip() else []
        
        # Entities: normalize to categorized dict {category: [names]}
        raw_entities = data.get("entities", {})
        entities = self._normalize_entities(raw_entities)
        
        # Topics: list of strings
        raw_topics = data.get("topics", [])
        if isinstance(raw_topics, list):
            topics = [str(t).strip() for t in raw_topics if str(t).strip()][:10]
        else:
            topics = [str(raw_topics).strip()] if str(raw_topics).strip() else []
        
        return {
            "title": title,
            "summary": summary,
            "key_points": key_points,
            "entities": entities,
            "topics": topics,
            "message_count": message_count,
        }

    def _normalize_entities(self, raw: Any) -> Dict[str, List[str]]:
        """
        Normalize entities to {category: [names]} format.
        
        Handles multiple formats the LLM might return:
        - {"people": [...], "technologies": [...]}  -> pass through
        - ["entity1", "entity2"]                    -> {"general": [...]}
        - [{"name": "X", "type": "person"}, ...]   -> group by type
        """
        if isinstance(raw, dict):
            # Already categorized - validate values are lists of strings
            result = {}
            for category, names in raw.items():
                if isinstance(names, list):
                    cleaned = [str(n).strip() for n in names if str(n).strip()]
                    if cleaned:
                        result[str(category)] = cleaned
            return result
        
        if isinstance(raw, list):
            if not raw:
                return {}
            # Check if list of dicts with name/type fields
            if isinstance(raw[0], dict) and ("name" in raw[0] or "type" in raw[0]):
                grouped: Dict[str, List[str]] = {}
                for item in raw:
                    if isinstance(item, dict):
                        name = str(item.get("name", "")).strip()
                        etype = str(item.get("type", "general")).strip().lower()
                        if name:
                            grouped.setdefault(etype, []).append(name)
                return grouped
            # Flat list of strings
            flat = [str(e).strip() for e in raw if str(e).strip()]
            return {"general": flat} if flat else {}
        
        return {}

    # =========================================================================
    # Database persistence
    # =========================================================================

    async def _save_summary(
        self,
        chat_id: UUID,
        summary_type: str,
        summary_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Save summary to database (upsert).
        
        Constructs summary_text from the prose summary + key points for
        full-text search indexing. Entities stored as structured JSON.
        """
        key_points = summary_data.get("key_points", [])
        prose_summary = summary_data.get("summary", "")
        
        # Build summary_text for FTS: prose paragraph + bullet points
        parts = []
        if prose_summary:
            parts.append(prose_summary)
        if key_points:
            parts.append("\n".join(f"- {point}" for point in key_points))
        summary_text = "\n\n".join(parts) if parts else "No summary available"
        
        # Entities: store as structured dict (already normalized by _normalize_summary_data)
        entities_payload = {
            "entities": summary_data.get("entities", {}),
            "topics": summary_data.get("topics", [])
        }
        
        # Save via repository
        result = await self._chat_repository.create_chat_summary(
            chat_id=chat_id,
            summary_type=summary_type,
            title=summary_data.get("title"),
            summary_text=summary_text,
            key_points=key_points,
            entities=entities_payload,
            llm_model=self._llm_model,
            metadata={
                "message_count": summary_data.get("message_count", 0),
            }
        )
        
        return result


    
    def dispose(self) -> None:
        """Clean up resources held by this service."""
        self._is_disposed = True
