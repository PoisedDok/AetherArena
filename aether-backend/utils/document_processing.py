"""
Extractive Document Processing Utility.

Pipeline: Read -> Gate -> Sentence Split -> LexRank Score -> Select.
- Gate: Content that fits within the per-file token budget is returned full.
- Sentence splitting: NLTK sent_tokenize with character offset tracking.
- Scoring: LexRank (Erkan & Radev, 2004) via sumy — sentence-level graph
  centrality over TF-IDF cosine similarity.
- Selection: Top-N sentences by LexRank score, reassembled in document order.

@.architecture
Incoming: services/daemons/filesystem/daemon.py -> {file_path}
          application/chat/summary_service.py -> {text, max_tokens}
          core/runtime/interpreter.py -> {text}
          ws/application/artifact_processor.py -> {text, filename}
Processing: extract_context(), extract_from_text(), _lexrank_select()
Outgoing: condensed context string
"""

import logging
import re
from pathlib import Path
from dataclasses import dataclass
from typing import List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module constants
# ---------------------------------------------------------------------------

_PROSE_EXTENSIONS = {
    '.txt', '.md', '.rst', '.log', '.html', '.xml',
}
_CODE_EXTENSIONS = {
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h',
    '.cs', '.go', '.rs', '.rb', '.php', '.css', '.json', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf', '.sh', '.bash', '.zsh', '.sql', '.r',
    '.swift', '.kt', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs',
    '.lua', '.pl', '.pm', '.csv', '.tsv',
}
_TEXT_EXTENSIONS = _PROSE_EXTENSIONS | _CODE_EXTENSIONS

_OFFICE_EXTENSIONS = {'.docx', '.pptx', '.xlsx'}

_MIN_SENTENCE_CHARS = 20
_BIB_MARKER_RE = re.compile(
    r'(?:In\s+Proceedings|arXiv\s+preprint|arXiv:|arXiv\.org|'
    r'URL\s+https?://|doi\.org/|'
    r'IEEE/CVF|ACM\s+Conference|'
    r'International\s+Conference)',
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# NLTK / sumy compatibility
# ---------------------------------------------------------------------------

def _ensure_nltk_data() -> None:
    """Ensure NLTK punkt sentence tokenizer resources are available."""
    import nltk

    def _has(path: str) -> bool:
        try:
            nltk.data.find(path)
            return True
        except LookupError:
            return False

    if _has('tokenizers/punkt_tab/english/') or _has('tokenizers/punkt/english.pickle'):
        return

    for resource in ('punkt_tab', 'punkt'):
        try:
            nltk.download(resource, quiet=True)
        except Exception:
            continue
        if _has('tokenizers/punkt_tab/english/') or _has('tokenizers/punkt/english.pickle'):
            return

    raise LookupError("Missing NLTK punkt sentence tokenizer resources.")


def _patch_sumy_tokenizer() -> None:
    """Make sumy compatible with NLTK punkt_tab resources."""
    from sumy.nlp import tokenizers as sumy_tokenizers

    if getattr(sumy_tokenizers.Tokenizer, '_aether_punkt_patch', False):
        return

    original = sumy_tokenizers.Tokenizer._get_sentence_tokenizer

    def _patched(self, language):
        try:
            return original(self, language)
        except LookupError as original_error:
            try:
                from nltk.tokenize import PunktTokenizer
                return PunktTokenizer(language)
            except Exception:
                raise original_error

    sumy_tokenizers.Tokenizer._get_sentence_tokenizer = _patched
    sumy_tokenizers.Tokenizer._aether_punkt_patch = True


# ---------------------------------------------------------------------------
# Provenance data structures
# ---------------------------------------------------------------------------

@dataclass
class ChunkProvenance:
    """Metadata tying a selected sentence back to the source document."""
    index: int                  # Position in the full sentence list (0-based)
    start_char: int             # Character offset in cleaned source text
    end_char: int               # Character offset end
    section: Optional[str]      # Nearest preceding section header, or None
    text: str                   # Sentence content


@dataclass
class ExtractionResult:
    """Structured output from provenance-aware extraction."""
    text: str                           # Flat string (same format as extract_context)
    chunks_selected: int
    chunks_total: int
    provenance: List[ChunkProvenance]   # Ordered by document position


class DocumentUtility:
    """Sentence-level extractive summarizer using LexRank (Erkan & Radev, 2004).

    Replaces the previous chunk-oriented hybrid extractor with standard
    sentence-level extraction via sumy's LexRankSummarizer.  This
    aligns with the extractive summarization literature where the atomic unit
    of selection is the individual sentence, not a multi-sentence chunk.
    """

    _CHARS_PER_TOKEN = 5

    def __init__(
        self,
        max_context_tokens: int = 1_000,
        target_sentences: int = 30,
    ):
        self.max_context_tokens = max_context_tokens
        self.target_sentences = target_sentences

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def extract_context(self, file_path: Path) -> Optional[str]:
        """Extract context from a file.  Returns None on unsupported/missing/error."""
        try:
            if not file_path.exists():
                return None

            suffix = file_path.suffix.lower()

            if suffix == '.pdf':
                return self._process_pdf(file_path)

            if suffix in _OFFICE_EXTENSIONS:
                return self._process_office(file_path)

            if suffix not in _TEXT_EXTENSIONS:
                logger.debug("Unsupported extension: %s", suffix)
                return None

            return self._extract_from_file(file_path, suffix)

        except Exception as e:
            logger.error("Failed to extract context from %s: %s", file_path, e, exc_info=True)
            return None

    def extract_from_text(
        self,
        text: str,
        filename: str = "document",
        *,
        is_code: bool = False,
    ) -> Optional[str]:
        """Run Gate -> Split -> Score -> Select on in-memory text.

        Returns full text if within budget (zero signal loss), or an
        extractive summary with [SKIPPED SECTION] markers if content
        exceeds budget.
        """
        return self._extract_from_text(text, filename, is_code=is_code)

    def extract_with_provenance(
        self, file_path: Path,
    ) -> Optional[ExtractionResult]:
        """Extract context with per-sentence provenance metadata.

        Returns an ExtractionResult whose ``.text`` field matches the flat
        string that ``extract_context()`` would produce, plus a
        ``provenance`` list mapping each selected sentence to its character
        offsets and nearest section header in the cleaned source text.
        """
        try:
            if not file_path.exists():
                return None

            suffix = file_path.suffix.lower()

            if suffix == '.pdf':
                raw = self._read_pdf_text(file_path)
                if not raw:
                    return None
                source_text = self._clean_pdf_text(raw)
                is_code = False
            elif suffix in _OFFICE_EXTENSIONS:
                source_text = self._read_office_text(file_path)
                is_code = False
            elif suffix in _TEXT_EXTENSIONS:
                source_text = file_path.read_text(
                    encoding='utf-8', errors='ignore',
                )
                is_code = suffix in _CODE_EXTENSIONS
            else:
                return None

            if not source_text or not source_text.strip():
                return None

            name = file_path.name

            content_tokens = len(source_text) // self._CHARS_PER_TOKEN
            if content_tokens <= self.max_context_tokens:
                return ExtractionResult(
                    text=f"[FILE: {name}] (Type: Full)\n---\n{source_text}",
                    chunks_selected=1,
                    chunks_total=1,
                    provenance=[ChunkProvenance(
                        index=0,
                        start_char=0,
                        end_char=len(source_text),
                        section=None,
                        text=source_text,
                    )],
                )

            all_sents = self._split_sentences_with_offsets(source_text)
            if not all_sents:
                return None

            n = len(all_sents)
            selected_indices = self._lexrank_select(
                source_text, all_sents, min(self.target_sentences, n),
            )

            sections = self._detect_sections(source_text)

            provenance: List[ChunkProvenance] = []
            for idx in sorted(selected_indices):
                s_text, s_start, s_end = all_sents[idx]
                section = self._section_for_offset(sections, s_start)
                provenance.append(ChunkProvenance(
                    index=idx,
                    start_char=s_start,
                    end_char=s_end,
                    section=section,
                    text=s_text,
                ))

            parts: List[str] = []
            prev = -1
            for idx in sorted(selected_indices):
                if prev != -1 and idx > prev + 1:
                    parts.append("\n... [SKIPPED SECTION] ...\n")
                parts.append(all_sents[idx][0])
                prev = idx

            summary = " ".join(parts)
            flat = (
                f"[FILE: {name}] (Summarized"
                f" \u2014 {len(selected_indices)}/{n} sentences)\n---\n{summary}"
            )

            return ExtractionResult(
                text=flat,
                chunks_selected=len(selected_indices),
                chunks_total=n,
                provenance=provenance,
            )

        except Exception as e:
            logger.error(
                "Provenance extraction failed for %s: %s",
                file_path, e, exc_info=True,
            )
            return None

    # ------------------------------------------------------------------
    # File reading
    # ------------------------------------------------------------------

    def _extract_from_file(self, file_path: Path, suffix: str) -> Optional[str]:
        """Read text file and route through the unified extraction pipeline."""
        try:
            text = file_path.read_text(encoding='utf-8', errors='ignore')
            is_code = suffix in _CODE_EXTENSIONS
            return self._extract_from_text(text, file_path.name, is_code=is_code)
        except Exception as e:
            logger.error("Error processing file %s: %s", file_path, e)
            return None

    # ------------------------------------------------------------------
    # Core extraction
    # ------------------------------------------------------------------

    def _extract_from_text(
        self, text: str, name: str, *, is_code: bool = False,
    ) -> Optional[str]:
        """Gate on content tokens, then split, score, and select sentences."""
        content_tokens = len(text) // self._CHARS_PER_TOKEN
        if content_tokens <= self.max_context_tokens:
            if not text.strip():
                return f"[FILE: {name}] (Empty content)"
            return f"[FILE: {name}] (Type: Full)\n---\n{text}"

        # Hard fallback: Do NOT attempt NLP summarization (LexRank) on massive strings.
        # LexRank builds an O(N^2) sentence graph which will OOM on massive logs or texts.
        # If the file is > 100,000 characters, treat it like code (head/tail slice).
        if is_code or len(text) > 100000:
            return self._extract_code(text, name)

        all_sents = self._split_sentences_with_offsets(text)
        if not all_sents:
            return f"[FILE: {name}] (Empty content)"

        n = len(all_sents)
        target = min(self.target_sentences, n)
        selected_indices = self._lexrank_select(text, all_sents, target)

        parts: List[str] = []
        prev = -1
        for idx in sorted(selected_indices):
            if prev != -1 and idx > prev + 1:
                parts.append("\n... [SKIPPED SECTION] ...\n")
            parts.append(all_sents[idx][0])
            prev = idx

        summary = " ".join(parts)
        header = f"[FILE: {name}] (Summarized \u2014 {len(selected_indices)}/{n} sentences)\n---\n"
        return header + summary

    def _extract_code(self, text: str, name: str) -> str:
        """Line-based head/tail extraction for code files.

        Sentence splitting is meaningless for code.  The gate already
        returns code that fits the token budget in full.  For oversized
        code that somehow exceeds the budget, preserve the top (imports,
        class signatures) and bottom (main block, final functions).
        """
        max_chars = self.max_context_tokens * self._CHARS_PER_TOKEN

        lines = text.splitlines()
        total = len(lines)
        head_n = min(self.target_sentences * 2, total)
        tail_n = min(self.target_sentences, total)

        if head_n + tail_n >= total:
            body = text
            summary_info = "Type: Full"
        else:
            head = lines[:head_n]
            tail = lines[total - tail_n:]
            body = "\n".join(head) + "\n\n... [SKIPPED SECTION] ...\n\n" + "\n".join(tail)
            summary_info = f"Summarized \u2014 {head_n + tail_n}/{total} lines"

        # Fallback for dense/minified files where line count is small but characters are huge
        if len(body) > max_chars:
            half = max_chars // 2
            # Use safe slicing to avoid breaking mid-character
            body = body[:half] + "\n\n... [TRUNCATED DUE TO LENGTH] ...\n\n" + body[-half:]
            summary_info += f" / Capped to {max_chars} chars"

        return f"[FILE: {name}] ({summary_info})\n---\n{body}"

    # ------------------------------------------------------------------
    # Sentence splitting with offset tracking
    # ------------------------------------------------------------------

    def _split_sentences_with_offsets(
        self, text: str,
    ) -> List[Tuple[str, int, int]]:
        """Split text into sentences via NLTK and track character offsets.

        Returns list of (sentence_text, start_char, end_char).  Noise
        sentences (too short, pure numbers, bibliography fragments) are
        filtered out.
        """
        _ensure_nltk_data()
        import nltk

        try:
            raw_sents = nltk.sent_tokenize(text, language='english')
        except LookupError:
            from nltk.tokenize import PunktTokenizer
            raw_sents = PunktTokenizer('english').tokenize(text)

        result: List[Tuple[str, int, int]] = []
        search_from = 0
        for sent in raw_sents:
            sent = sent.strip()
            if not sent:
                continue

            pos = text.find(sent, search_from)
            if pos == -1:
                pos = text.find(sent)
            if pos == -1:
                continue

            end = pos + len(sent)

            if not self._is_noise_sentence(sent):
                result.append((sent, pos, end))

            search_from = pos + 1

        return result

    @staticmethod
    def _is_noise_sentence(sent: str) -> bool:
        """Filter non-informative sentence fragments."""
        if len(sent) < _MIN_SENTENCE_CHARS:
            return True
        if not any(c.isalpha() for c in sent):
            return True
        if re.match(r'^(\d{1,4}|[ivxlcdm]+)\.?$', sent, re.IGNORECASE):
            return True
        if ('http://' in sent or 'https://' in sent) and len(sent.split()) <= 3:
            return True
        if len(_BIB_MARKER_RE.findall(sent)) >= 2:
            return True
        return False

    # ------------------------------------------------------------------
    # LexRank sentence scoring
    # ------------------------------------------------------------------

    def _lexrank_select(
        self,
        full_text: str,
        all_sents: List[Tuple[str, int, int]],
        n_sentences: int,
    ) -> Set[int]:
        """Score sentences with LexRank and return indices of top-N.

        Uses sumy's LexRankSummarizer (Erkan & Radev, 2004).  Selected
        sentences are mapped back to the offset-tracked list by text
        matching.
        """
        try:
            return self._lexrank_via_sumy(full_text, all_sents, n_sentences)
        except Exception as e:
            logger.warning("LexRank scoring failed, falling back to lead-N: %s", e)
            return set(range(min(n_sentences, len(all_sents))))

    def _lexrank_via_sumy(
        self,
        full_text: str,
        all_sents: List[Tuple[str, int, int]],
        n_sentences: int,
    ) -> Set[int]:
        """Run sumy LexRank and map results back to offset-tracked sentences."""
        _ensure_nltk_data()
        _patch_sumy_tokenizer()

        from sumy.summarizers.lex_rank import LexRankSummarizer
        from sumy.nlp.tokenizers import Tokenizer as SumyTokenizer
        from sumy.parsers.plaintext import PlaintextParser
        from sumy.nlp.stemmers import Stemmer
        from sumy.utils import get_stop_words

        parser = PlaintextParser.from_string(full_text, SumyTokenizer('english'))
        summarizer = LexRankSummarizer(Stemmer('english'))
        summarizer.stop_words = get_stop_words('english')

        summary_sents = summarizer(parser.document, n_sentences)
        selected_texts = [str(s).strip() for s in summary_sents]

        sent_text_to_indices: dict[str, List[int]] = {}
        for idx, (s_text, _, _) in enumerate(all_sents):
            normed = s_text.strip()
            sent_text_to_indices.setdefault(normed, []).append(idx)

        selected_indices: Set[int] = set()
        for sel_text in selected_texts:
            candidates = sent_text_to_indices.get(sel_text)
            if candidates:
                for c in candidates:
                    if c not in selected_indices:
                        selected_indices.add(c)
                        break
            else:
                for idx, (s_text, _, _) in enumerate(all_sents):
                    if idx not in selected_indices and sel_text in s_text:
                        selected_indices.add(idx)
                        break

        if len(selected_indices) < n_sentences:
            for idx in range(len(all_sents)):
                if len(selected_indices) >= n_sentences:
                    break
                selected_indices.add(idx)

        return selected_indices

    # ------------------------------------------------------------------
    # PDF processing
    # ------------------------------------------------------------------

    def _process_pdf(self, file_path: Path) -> Optional[str]:
        """Extract text from PDF via pypdfium2, clean, and summarize."""
        try:
            import pypdfium2 as pdfium
        except ImportError:
            logger.error("pypdfium2 not installed — cannot process PDF: %s", file_path.name)
            return None

        pdf = None
        try:
            pdf = pdfium.PdfDocument(str(file_path))
            text_parts: List[str] = []

            for page in pdf:
                text_page = None
                try:
                    text_page = page.get_textpage()
                    text = text_page.get_text_range()
                    if text:
                        text_parts.append(text)
                finally:
                    if text_page is not None:
                        text_page.close()
                    page.close()

            full_text = "\n".join(text_parts)
            if not full_text.strip():
                return f"[FILE: {file_path.name}] (PDF appeared empty or image-only)"

            cleaned = self._clean_pdf_text(full_text)
            return self._extract_from_text(cleaned, file_path.name, is_code=False)

        except Exception as e:
            logger.error("PDF processing failed for %s: %s", file_path.name, e)
            return None
        finally:
            if pdf is not None:
                pdf.close()

    # ------------------------------------------------------------------
    # Office document processing (DOCX, PPTX, XLSX via SimpleDirectoryReader)
    # ------------------------------------------------------------------

    def _process_office(self, file_path: Path) -> Optional[str]:
        """Extract text from Office documents via SimpleDirectoryReader.
        
        This replaces the Docling-based extraction, which was too heavy
        for background context extraction in the filesystem daemon.
        """
        try:
            from llama_index.core import SimpleDirectoryReader
        except ImportError:
            logger.debug("SimpleDirectoryReader (llama-index) not available")
            return None

        try:
            # SimpleDirectoryReader handles DOCX, PPTX, XLSX natively.
            documents = SimpleDirectoryReader(input_files=[str(file_path)]).load_data()
            if not documents:
                return f"[FILE: {file_path.name}] (Office document appeared empty)"

            content = "\n\n".join(doc.text for doc in documents)
            if not content.strip():
                return f"[FILE: {file_path.name}] (Office document appeared empty)"

            return self._extract_from_text(content, file_path.name, is_code=False)

        except Exception as e:
            logger.error(
                "Office document processing failed for %s: %s", file_path.name, e,
            )
            return None

    # ------------------------------------------------------------------
    # PDF text cleaning
    # ------------------------------------------------------------------

    def _clean_pdf_text(self, text: str) -> str:
        """Remove academic PDF noise while preserving content."""
        text = re.sub(r'\[\d+(?:\s*,\s*\d+)*(?:\s*-\s*\d+)?\]', '', text)
        text = re.sub(r'\([A-Z][a-zA-Z]+\s+et\s+al\.,?\s+\d{4}\)', '', text)
        text = re.sub(r'\([A-Z][a-zA-Z]+,?\s+\d{4}\)', '', text)

        lines = text.split('\n')
        cleaned: List[str] = []
        skip_section = False

        for line in lines:
            s = line.strip()
            if not s:
                continue

            if re.match(
                r'^(?:\d+\.?\s+|[IVX]+\.?\s+)?'
                r'(?:neurips\s+paper\s+)?'
                r'(references|bibliography|appendix|supplementary|'
                r'acknowledg(?:e?ment)s?|checklist|'
                r'broader\s+impact(?:\s+statement)?|'
                r'ethics\s+statement|'
                r'reproducibility\s+statement)\b'
                r'(?:\s+(?:material[s]?|information|data|section[s]?|[A-Z0-9]+))?\s*$',
                s, re.IGNORECASE,
            ):
                skip_section = True
                continue
            if not skip_section and re.match(r'^Answer:\s*\[(Yes|No|NA|N/A)\]', s):
                skip_section = True
                continue
            if skip_section and re.match(r'^(\d+\.?\s+[A-Z]|[IVX]+\.?\s+[A-Z]|#{1,3}\s+)', s):
                skip_section = False
            if skip_section:
                continue

            if re.match(r'^(\d{1,4}|[ivxlcdm]+)$', s, re.IGNORECASE):
                continue
            if len(s) < 20 and not any(c.isalpha() for c in s):
                continue

            if any(h in s for h in (
                'Under review', 'Accepted at', 'Published as',
                'Preprint', 'arXiv:', 'doi:', 'Page ', 'Table of Contents',
            )):
                continue

            if ('http://' in s or 'https://' in s) and len(s.split()) <= 3:
                continue

            cleaned.append(s)

        return self._reconstruct_paragraphs(cleaned)

    @staticmethod
    def _reconstruct_paragraphs(lines: List[str]) -> str:
        """Join broken PDF lines into coherent paragraphs."""
        paragraphs: List[str] = []
        current: List[str] = []

        for line in lines:
            is_continuation = False
            if current:
                prev = current[-1]
                if not re.search(r'[.!?]\s*$', prev):
                    is_continuation = True
                elif line and line[0].islower():
                    is_continuation = True
                elif re.match(
                    r'^(and|or|but|however|therefore|thus|moreover|furthermore|additionally)\b',
                    line, re.IGNORECASE,
                ):
                    is_continuation = True

            if is_continuation:
                current.append(line)
            else:
                if current:
                    para = ' '.join(current)
                    if len(para) > 50 and sum(c.isalpha() for c in para) > 20:
                        paragraphs.append(para)
                current = [line]

        if current:
            para = ' '.join(current)
            if len(para) > 50 and sum(c.isalpha() for c in para) > 20:
                paragraphs.append(para)

        return '\n\n'.join(paragraphs)

    # ------------------------------------------------------------------
    # Section detection (provenance)
    # ------------------------------------------------------------------

    @staticmethod
    def _detect_sections(text: str) -> List[Tuple[int, str]]:
        """Identify section headers and their character positions."""
        sections: List[Tuple[int, str]] = []

        for m in re.finditer(
            r'(?:^|\n)((?:\d+\.)*\d+)\s+'
            r'((?:[A-Z][a-zA-Z\-]+(?:\s+|$)){1,6})',
            text,
        ):
            header = f"{m.group(1)} {m.group(2).strip()}"
            if 3 < len(header) < 80:
                sections.append((m.start(1), header))

        for m in re.finditer(r'(?:^|\n)(#{1,4})\s+([^\n]{2,60})', text):
            sections.append((m.start(1), m.group(2).strip()))

        for m in re.finditer(
            r'(?:^|\n)([A-Z]{4,}(?:\s+[A-Z]{3,}){0,4})\b', text,
        ):
            h = m.group(1).strip()
            if len(h) >= 4:
                sections.append((m.start(1), h))

        sections.sort(key=lambda x: x[0])
        return sections

    @staticmethod
    def _section_for_offset(
        sections: List[Tuple[int, str]], offset: int,
    ) -> Optional[str]:
        """Return the most recent section header at or before *offset*."""
        result = None
        for pos, header in sections:
            if pos <= offset:
                result = header
            else:
                break
        return result

    # ------------------------------------------------------------------
    # Text reading for provenance
    # ------------------------------------------------------------------

    def _read_pdf_text(self, file_path: Path) -> Optional[str]:
        """Read raw text from PDF via pypdfium2 (no cleaning)."""
        try:
            import pypdfium2 as pdfium
        except ImportError:
            logger.error(
                "pypdfium2 not installed — cannot read PDF: %s",
                file_path.name,
            )
            return None

        pdf = None
        try:
            pdf = pdfium.PdfDocument(str(file_path))
            parts: List[str] = []
            for page in pdf:
                tp = None
                try:
                    tp = page.get_textpage()
                    t = tp.get_text_range()
                    if t:
                        parts.append(t)
                finally:
                    if tp is not None:
                        tp.close()
                    page.close()
            full = "\n".join(parts)
            return full if full.strip() else None
        except Exception as e:
            logger.error("PDF read failed for %s: %s", file_path.name, e)
            return None
        finally:
            if pdf is not None:
                pdf.close()

    def _read_office_text(self, file_path: Path) -> Optional[str]:
        """Read raw text from Office document via SimpleDirectoryReader."""
        try:
            from llama_index.core import SimpleDirectoryReader
        except ImportError:
            return None

        try:
            documents = SimpleDirectoryReader(input_files=[str(file_path)]).load_data()
            if not documents:
                return None
            content = "\n\n".join(doc.text for doc in documents)
            return content if content and content.strip() else None
        except Exception as e:
            logger.error("Office read failed for %s: %s", file_path.name, e)
            return None
