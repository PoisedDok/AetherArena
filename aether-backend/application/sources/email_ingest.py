"""
Cross-platform email ingestion (local .eml, .emlx, .mbox, and Outlook .msg files).

Supports:
- macOS Mail.app (.emlx files)
- Standard .eml files
- mbox archives
- Windows Outlook .msg files (future)

@.architecture
Incoming: application/services/source_indexing_service.py, daemons/email --- {path: str, max_items}
Processing: parse email messages, normalize headers/body into searchable text --- {JOB_LOAD_DATA, JOB_TRANSFORM_DATA}
Outgoing: application/services/source_indexing_service.py, daemons/email --- {List[dict] email items}
"""

import mailbox
from email import policy
from email.message import Message
from email.parser import BytesParser
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return ""


def _extract_text_parts(msg: Message) -> str:
    """
    Prefer text/plain parts. If none, fall back to text/html stripped to raw text.
    """
    texts: List[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            ctype = (part.get_content_type() or "").lower()
            if ctype not in {"text/plain", "text/html"}:
                continue
            try:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                body = payload.decode(charset, errors="replace")
            except Exception:
                continue
            if ctype == "text/html":
                # Keep it simple and deterministic; no external HTML parser.
                body = body.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
            texts.append(body)
    else:
        try:
            payload = msg.get_payload(decode=True) or b""
            charset = msg.get_content_charset() or "utf-8"
            texts.append(payload.decode(charset, errors="replace"))
        except Exception:
            pass

    # Prefer text/plain if present by ordering.
    plain = [t for t in texts if t.strip()]
    return "\n\n".join(plain).strip()


def parse_eml_bytes(raw: bytes) -> Dict[str, Any]:
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    return {
        "subject": _safe_str(msg.get("subject")),
        "from": _safe_str(msg.get("from")),
        "to": _safe_str(msg.get("to")),
        "cc": _safe_str(msg.get("cc")),
        "date": _safe_str(msg.get("date")),
        "message_id": _safe_str(msg.get("message-id")),
        "body": _extract_text_parts(msg),
    }


def iter_eml_files(path: Path) -> Iterable[Path]:
    if path.is_file() and path.suffix.lower() == ".eml":
        yield path
        return
    if path.is_dir():
        yield from sorted(path.rglob("*.eml"))


def read_eml_items(path: Path, max_items: Optional[int] = None) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    limit = max_items if max_items and max_items > 0 else None
    for idx, file_path in enumerate(iter_eml_files(path)):
        if limit is not None and idx >= limit:
            break
        raw = file_path.read_bytes()
        parsed = parse_eml_bytes(raw)
        parsed["source_path"] = str(file_path)
        parsed["source_type"] = "eml"
        items.append(parsed)
    return items


def read_mbox_items(path: Path, max_items: Optional[int] = None) -> List[Dict[str, Any]]:
    if not path.is_file():
        raise ValueError("mbox path must be a file")
    limit = max_items if max_items and max_items > 0 else None

    items: List[Dict[str, Any]] = []
    mbox = mailbox.mbox(path, factory=None, create=False)
    try:
        for idx, msg in enumerate(mbox):
            if limit is not None and idx >= limit:
                break
            if msg is None:
                continue
            # mailbox returns email.message.Message-like object; convert to bytes safely.
            raw = msg.as_bytes()
            parsed = parse_eml_bytes(raw)
            parsed["source_path"] = str(path)
            parsed["source_type"] = "mbox"
            parsed["mbox_index"] = idx
            items.append(parsed)
    finally:
        try:
            mbox.close()
        except Exception:
            pass
    return items


def format_email_item(item: Dict[str, Any]) -> str:
    subject = (item.get("subject") or "").strip()
    from_ = (item.get("from") or "").strip()
    to = (item.get("to") or "").strip()
    cc = (item.get("cc") or "").strip()
    date = (item.get("date") or "").strip()
    message_id = (item.get("message_id") or "").strip()
    body = (item.get("body") or "").strip()

    parts = []
    if subject:
        parts.append(f"[Subject]: {subject}")
    if from_:
        parts.append(f"[From]: {from_}")
    if to:
        parts.append(f"[To]: {to}")
    if cc:
        parts.append(f"[CC]: {cc}")
    if date:
        parts.append(f"[Date]: {date}")
    if message_id:
        parts.append(f"[Message-ID]: {message_id}")
    if body:
        parts.append("")
        parts.append(body)
    return "\n".join(parts).strip()
