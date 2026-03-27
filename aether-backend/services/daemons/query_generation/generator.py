"""
Query generator following proactive-IR paper methodology.

Implements zero-shot query generation from Figure 3 of the paper.
"""
import re
import logging
from typing import List, Dict, Any, Optional
import httpx

logger = logging.getLogger(__name__)


class QueryGenerator:
    """
    Zero-shot query generator following proactive-IR paper.
    
    Uses the exact prompt structure from Figure 3 to generate queries
    from user context documents.
    """
    
    # Curiosity-Driven Event Signal Generation
    # NOT for search engines - for a proactive research agent that can investigate deeply
    ZERO_SHOT_PROMPT_TEMPLATE = """You are a pattern-detection system analyzing HIGH-SIGNAL user activity from 3 sources:

**SOURCES YOU ANALYZE:**
1. [EMAIL] - Messages, requests, reminders, deadlines, escalations
2. [FILESYSTEM] - File creation/edits (explicit work actions)
3. [BROWSER] - Page visits and searches (information gathering patterns)

**EVOLUTIONARY CONTEXT:**
You will see recent logs AND potentially queries you generated in the PREVIOUS batch.
Use this to evolve reasoning. If the user is continuing the same task, generate more
specific or complementary signals. If the user has shifted tasks, pivot.

WHEN TO GENERATE (look for cross-source high-signal patterns):

1. **ITERATIVE WORK LOOP**:
   - Repeated edits + repeated lookups on the same topic
   - Signal: user is actively solving or composing, may need targeted context

2. **DEADLINE/COMMITMENT + EVIDENCE GATHERING**:
   - Time pressure in communication plus related browsing/files
   - Signal: user making decisions under constraints

3. **MULTI-SOURCE TOPIC CONVERGENCE**:
   - Same topic appears in 2+ sources (email/browser/filesystem)
   - Signal: coherent engagement likely needs synthesis

4. **RESEARCH-TO-PRODUCTION TRANSITION**:
   - Reading materials plus creating notes/drafts/implementation files
   - Signal: user moving from exploration to execution

5. **PERSISTENT KNOWLEDGE GAP**:
   - Similar query patterns persist across batches without resolution
   - Signal: user may need bridge concepts or alternate framing

WHEN NOT TO GENERATE:
- Routine or fragmented activity with no coherent objective.
- Pure passive consumption with no continuity or action intent.
- Redundant signals that do not add value over previous batches.

FORMAT (if you find something):
- 15-20 terms max (COMPLETE the sentence - no truncation)
- lowercase, no special chars
- Statement: "user [action] while/with [context] suggests [need]"
- CRITICAL: Generate COMPLETE, grammatically correct queries
- Use ONLY facts from data below

Analyze data below and return 0-3 signals inside <query></query> tags:

{context}"""
    
    def __init__(
        self,
        api_base: str,
        model: str,
        api_key: str = "not-needed",
        timeout_seconds: float = 30.0,
        max_query_terms: int = 100,  # Increased to preserve full LLM output (was causing truncation)
        use_lowercase: bool = True,
        remove_special_chars: bool = True,
        temperature: float = 0.6,
        max_tokens: int = 10240,
    ):
        self.api_base = api_base.rstrip('/')
        self.model = model
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        self.max_query_terms = max_query_terms
        self.use_lowercase = use_lowercase
        self.remove_special_chars = remove_special_chars
        self.temperature = temperature
        self.max_tokens = max_tokens
        
        self.client = httpx.AsyncClient(timeout=timeout_seconds)
    
    async def close(self):
        """Close HTTP client."""
        await self.client.aclose()
    
    def _clean_query(self, raw_query: str) -> str:
        """
        Clean and validate generated query according to paper specs.
        
        - Max 20 terms (configurable)
        - Lowercase
        - No special characters
        """
        query = raw_query.strip()
        
        if self.use_lowercase:
            query = query.lower()
        
        if self.remove_special_chars:
            # Keep only alphanumeric and spaces
            query = re.sub(r'[^a-z0-9\s]', ' ', query)
        
        # Collapse multiple spaces
        query = ' '.join(query.split())
        
        # Limit to max terms
        terms = query.split()
        if len(terms) > self.max_query_terms:
            query = ' '.join(terms[:self.max_query_terms])
        
        return query
    
    def _extract_queries_from_response(self, response: str) -> List[str]:
        """
        Extract multiple queries from LLM response.
        
        Primary: <query></query> tags (paper spec)
        Fallback: Line-based parsing (SLMs often ignore XML instructions)
        """
        # Try XML tags first
        matches = re.findall(r'<query>(.*?)</query>', response, re.DOTALL | re.IGNORECASE)
        if matches:
            queries = [match.strip() for match in matches if match.strip()]
            return queries[:3]  # Max 3 per new prompt
        
        # Fallback: Parse as newline-separated queries
        # SLMs (lfm-1.2B) often ignore XML formatting
        lines = response.strip().split('\n')
        queries = []
        for line in lines:
            line = line.strip()
            if not line or len(line) < 5:
                continue
            # Remove prefixes like "1. ", "- ", etc.
            line = re.sub(r'^\d+[\.\)]\s*', '', line)
            line = re.sub(r'^[-\*]\s*', '', line)
            if line and len(line.split()) <= 20:  # Max 20 terms (reasonable query length)
                queries.append(line)
        
        return queries[:3]  # Max 3 queries
    
    async def generate_queries_cross_source(
        self,
        context_docs: List[Dict[str, Any]],
        active_sources: List[str],
        previous_batch: Optional[List[Dict[str, Any]]] = None
    ) -> List[str]:
        """
        Generate 3-5 queries from cross-source recent activity analysis.
        
        Args:
            context_docs: List of documents from multiple sources (9-20 total)
            active_sources: List of source names that contributed logs
            previous_batch: List of queries/context from the last successful run
        
        Returns:
            List of 3-5 generated query strings (or empty if no meaningful patterns)
        """
        if not context_docs:
            logger.warning("No context documents provided")
            return []
        
        try:
            # Format context from ALL sources
            context_str = self._format_cross_source_context(context_docs, active_sources)
            
            # Format evolutionary context (last 3 batches with full context)
            evolutionary_context = ""
            if previous_batch:
                evolutionary_context = "\n**PREVIOUS BATCHES CONTEXT (Last 3 batches - Evolve from this):**\n"
                evolutionary_context += "Use this history to understand what you already analyzed and avoid redundancy.\n\n"
                
                for i, q in enumerate(previous_batch, 1):
                    evolutionary_context += f"--- Previous Batch Signal {i} ---\n"
                    evolutionary_context += f"Query Generated: {q['query']}\n"
                    evolutionary_context += f"Batch ID: {q.get('batch_id', 'unknown')}\n"
                    evolutionary_context += "Based on these logs:\n"
                    
                    # Show the actual context that led to this query
                    prev_context_docs = q.get('context_docs', [])
                    for j, doc in enumerate(prev_context_docs[:3], 1):  # Show up to 3 docs per batch
                        metadata = doc.get('metadata', {}) if isinstance(doc.get('metadata'), dict) else {}
                        source = (doc.get('source') or metadata.get('source_daemon') or '').lower()
                        if source == 'query_generation':
                            source = 'query_gen'

                        if source == 'filesystem':
                            file_path = metadata.get('file_path') or metadata.get('path') or metadata.get('file_name', 'unknown file')
                            action = metadata.get('action', 'modified')
                            evolutionary_context += f"  • {action} {file_path}\n"
                            preview = doc.get('content') or metadata.get('content_preview')
                            if preview:
                                evolutionary_context += f"    Preview: {str(preview)[:100]}...\n"
                        elif source == 'browser':
                            url = metadata.get('url') or metadata.get('path') or doc.get('content') or 'unknown url'
                            title = metadata.get('title')
                            if title:
                                evolutionary_context += f"  • visited {title} ({url})\n"
                            else:
                                evolutionary_context += f"  • visited {url}\n"
                        elif source == 'email':
                            subject = metadata.get('subject') or metadata.get('title') or 'no subject'
                            sender = metadata.get('sender') or metadata.get('from')
                            sender_prefix = f"{sender} - " if sender else ""
                            evolutionary_context += f"  • email: {sender_prefix}{subject}\n"
                        elif source == 'query_gen':
                            prior_query = metadata.get('query') or doc.get('content') or 'unknown prior query'
                            evolutionary_context += f"  • prior generated query: {prior_query}\n"
                        elif 'file_path' in doc:
                            # Legacy fallback for pre-normalized rows
                            evolutionary_context += f"  • {doc.get('action', 'modified')} {doc.get('file_path', 'unknown file')}\n"
                            preview = doc.get('content_preview') or doc.get('content')
                            if preview:
                                evolutionary_context += f"    Preview: {str(preview)[:100]}...\n"
                        elif 'url' in doc:
                            evolutionary_context += f"  • visited {doc.get('url', 'unknown url')}\n"
                        elif 'subject' in doc:
                            evolutionary_context += f"  • email: {doc.get('subject', 'no subject')}\n"
                    evolutionary_context += "\n"
                
                evolutionary_context += "NOTE: Only generate NEW signals or EVOLVED signals if current logs show a deeper struggle, new direction, or significantly different pattern.\n"

            # Build prompt using agentic template
            prompt = self.ZERO_SHOT_PROMPT_TEMPLATE.format(context=f"{context_str}\n{evolutionary_context}")
            
            # Privacy-safe observability: log metadata only (no raw context payload).
            logger.info(
                "LLM prompt prepared (docs=%d, sources=%s, prompt_chars=%d)",
                len(context_docs),
                active_sources,
                len(prompt),
            )
            print("==== PROMPT ====")
            print(prompt)
            print("================")
            
            # Call LLM with centralized generation params
            response = await self.client.post(
                f"{self.api_base}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": "You are a strict pattern analyzer. Only generate signals for truly interesting cross-source patterns. Most of the time, return nothing."},
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": self.temperature,
                    "max_tokens": self.max_tokens,
                },
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                }
            )
            
            if response.status_code != 200:
                logger.error(f"LLM API error: {response.status_code} - {response.text}")
                return []
            
            result = response.json()
            raw_response = result.get("choices", [{}])[0].get("message", {}).get("content", "")
            
            # Privacy-safe observability: do not emit raw model text at INFO.
            logger.debug("LLM raw response received (chars=%d)", len(raw_response))
            
            # Extract queries from response
            raw_queries = self._extract_queries_from_response(raw_response)
            if not raw_queries:
                logger.info(f"✓ Pattern analyzer found NO interesting patterns in {len(context_docs)} docs from {active_sources} (expected for routine activity)")
                return []
            
            # Clean according to paper specs
            cleaned_queries = [self._clean_query(q) for q in raw_queries]
            cleaned_queries = [q for q in cleaned_queries if q]  # Filter empty
            
            if not cleaned_queries:
                logger.info("✓ Pattern analyzer found NO interesting patterns after cleaning (routine activity)")
                return []
            
            logger.info(
                "Generated %d curiosity signal(s) from %d cross-source docs",
                len(cleaned_queries),
                len(context_docs),
            )
            logger.debug("Generated queries: %s", cleaned_queries)
            return cleaned_queries
            
        except Exception as e:
            logger.error(f"Cross-source query generation failed: {e}", exc_info=True)
            return []
    
    def _format_cross_source_context(self, docs: List[Dict[str, Any]], sources: List[str]) -> str:
        """
        Format documents from multiple sources for cross-source pattern detection.
        
        Includes actual content for filesystem + rich metadata for browser/windows.
        Follows proactive-IR paper: "documents which you have read"
        """
        # Group logs by source
        source_groups = {}
        for doc in docs:
            explicit_source = (doc.get('_source_daemon') or doc.get('source') or '').lower()
            if explicit_source == 'query_generation':
                explicit_source = 'query_gen'

            if explicit_source in {'browser', 'email', 'filesystem'}:
                source = explicit_source
            elif 'url' in doc and 'window_title' not in doc:
                source = 'browser'
            elif 'sender' in doc:
                source = 'email'
            elif 'file_path' in doc:
                source = 'filesystem'
            else:
                source = 'unknown'
            
            if source not in source_groups:
                source_groups[source] = []
            source_groups[source].append(doc)
        
        # Build context string showing cross-source patterns
        context_parts = [f"Recent activity across {len(source_groups)} sources:"]
        context_parts.append("")
        
        for source in sources:
            if source not in source_groups:
                continue
            
            source_docs = source_groups[source]
            context_parts.append(f"[{source.upper()}] - {len(source_docs)} recent events:")
            context_parts.append("")
            
            for i, doc in enumerate(source_docs[:5], 1):  # Max 5 per source
                metadata = doc.get('metadata', doc)
                if source == "browser":
                    # Rich metadata: URL contains search queries + behavioral signals
                    url = metadata.get('url', '')
                    title = metadata.get('title', 'No title')
                    visit_count = metadata.get('visit_count', 1)
                    typed_count = metadata.get('typed_count', 0)
                    
                    # Behavioral importance signal
                    importance = ""
                    if typed_count > 5:
                        importance = " [FREQUENTLY TYPED - HIGH IMPORTANCE]"
                    elif visit_count > 20:
                        importance = " [REPEATEDLY VISITED]"
                    elif typed_count > 0:
                        importance = " [DIRECTLY NAVIGATED]"
                    
                    context_parts.append(f"  Document {i}:")
                    context_parts.append(f"    Page: {title}{importance}")
                    context_parts.append(f"    URL: {url}")
                    context_parts.append(f"    Usage: visited {visit_count}x, typed {typed_count}x")
                    
                elif source == "email":
                    # Content available: subject + body preview
                    sender = metadata.get('sender', 'Unknown')
                    subject = metadata.get('subject', 'No subject')
                    body = metadata.get('body_preview', doc.get('content', ''))
                    context_parts.append(f"  Document {i}:")
                    context_parts.append(f"    Email from: {sender}")
                    context_parts.append(f"    Subject: {subject}")
                    if body:
                        context_parts.append(f"    Content: {body}")
                    
                elif source == "filesystem":
                    # ACTUAL CONTENT (paper's "documents you have read")
                    action = metadata.get('action', 'modified')
                    file_name = metadata.get('file_name', 'unknown')
                    file_path = metadata.get('file_path', '')
                    content = metadata.get('content_preview', doc.get('content', ''))
                    
                    context_parts.append(f"  Document {i}:")
                    context_parts.append(f"    Action: {action} {file_name}")
                    context_parts.append(f"    Path: {file_path}")
                    
                    if content:
                        # This is the key: actual document content for LLM
                        context_parts.append(f"    Content: {content}")
                    else:
                        context_parts.append("    Content: [Binary or non-text file]")
                    
                else:
                    context_parts.append(f"  Document {i}: {str(doc)[:200]}")
                
                context_parts.append("")  # Blank line between documents
        
        return "\n".join(context_parts)
