#!/usr/bin/env python3

"""
Aether-RAG MCP server (stdio JSON-RPC).

@.architecture
Incoming: MCP JSON-RPC over stdin --- {initialize, tools/list, tools/call}
Processing: index discovery + semantic search via in-process Aether-RAG library --- {JOB_LIST, JOB_SEARCH_INDEX}
Outgoing: MCP JSON-RPC over stdout --- {TextContent responses, JSON payloads}

CRITICAL: This implementation MUST NOT depend on external binaries like `aether_rag`.
It runs inside the backend venv via `python -m aether_rag.mcp` and uses library APIs directly.
"""

import contextlib
import ctypes
import io
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from .api import AetherRagSearcher
from .cli import AetherRagCLI

_CLI = AetherRagCLI()


@contextlib.contextmanager
def _suppress_stdio() -> Any:
    """
    MCP protocol uses stdout for JSON-RPC frames.
    Any library prints to stdout/stderr will corrupt the stream, so we suppress them.
    """
    # Python-level redirect is not sufficient for native libs that write directly to FD 1/2.
    # We redirect the underlying file descriptors to /dev/null for the duration.
    libc = None
    try:
        libc = ctypes.CDLL(None)
    except Exception:
        libc = None

    def _fflush_all() -> None:
        try:
            if libc is not None and hasattr(libc, "fflush"):
                libc.fflush(None)
        except Exception:
            pass

    _fflush_all()
    devnull_fd = os.open(os.devnull, os.O_WRONLY)
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)
    try:
        os.dup2(devnull_fd, 1)
        os.dup2(devnull_fd, 2)
        _fflush_all()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            yield
    finally:
        try:
            _fflush_all()
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
            _fflush_all()
        finally:
            try:
                os.close(devnull_fd)
            except Exception:
                pass
            try:
                os.close(saved_stdout)
            except Exception:
                pass
            try:
                os.close(saved_stderr)
            except Exception:
                pass


def _json_default(o: Any) -> Any:
    # Best-effort conversion for numpy scalars and other non-JSON types.
    try:
        import numpy as np  # type: ignore

        if isinstance(o, (np.floating, np.integer, np.bool_)):
            return o.item()
    except Exception:
        pass
    if isinstance(o, Path):
        return str(o)
    return str(o)


def _safe_json_text(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default)


def _discover_indexes_current_project() -> List[str]:
    """
    Return index identifiers that are safe to pass to aether_rag_search's `index_name`.

    Includes:
    - CLI indexes: `.aether-rag/indexes/<name>/...` => identifier = <name>
    - App indexes: `**/<file_base>.aether-rag.meta.json` => identifier = <file_base> (preferred)
    """
    discovered = _CLI._discover_indexes_in_project(Path.cwd())
    identifiers: List[str] = []
    for idx in discovered:
        if not isinstance(idx, dict):
            continue
        idx_type = idx.get("type")
        if idx_type == "cli":
            name = idx.get("name")
            if isinstance(name, str) and name:
                identifiers.append(name)
        elif idx_type == "app":
            meta_path = idx.get("path")
            try:
                meta_p = Path(str(meta_path))
                file_base = meta_p.name.replace(".aether-rag.meta.json", "")
                if file_base:
                    identifiers.append(file_base)
            except Exception:
                continue
    # Deduplicate while preserving order
    out: List[str] = []
    seen = set()
    for name in identifiers:
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _resolve_index_path(index_name: str) -> str:
    # Prefer current project's .aether-rag/indexes/<name>/documents.aether-rag
    if _CLI.index_exists(index_name):
        return _CLI.get_index_path(index_name)

    # If not in current project, try global registry match (non-interactive)
    matches = _CLI._find_all_matching_indexes(index_name)
    if not matches:
        raise FileNotFoundError(f"Index '{index_name}' not found")

    # Priority: current project first (already sorted by _find_all_matching_indexes)
    match = matches[0]
    if match.get("kind") == "cli":
        return str(match["index_dir"] / "documents.aether-rag")
    # App format: index file base is stored alongside meta
    meta_file = match["meta_file"]
    file_base = match["file_base"]
    return str(meta_file.parent / f"{file_base}.aether-rag")


def handle_request(request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if request.get("method") == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "capabilities": {"tools": {}},
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "aether-rag-mcp", "version": "1.0.0"},
            },
        }

    if request.get("method") == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request.get("id"),
            "result": {
                "tools": [
                    {
                        "name": "aether_rag_search",
                        "description": "Semantic search over a Aether-RAG index.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "index_name": {
                                    "type": "string",
                                    "description": "Name of the Aether-RAG index to search (use aether_rag_list to discover).",
                                },
                                "query": {"type": "string", "description": "Search query"},
                                "top_k": {
                                    "type": "integer",
                                    "default": 5,
                                    "minimum": 1,
                                    "maximum": 20,
                                },
                                "complexity": {
                                    "type": "integer",
                                    "default": 32,
                                    "minimum": 16,
                                    "maximum": 128,
                                },
                                "show_metadata": {"type": "boolean", "default": False},
                            },
                            "required": ["index_name", "query"],
                        },
                    },
                    {
                        "name": "aether_rag_list",
                        "description": "List available Aether-RAG indexes in the current project.",
                        "inputSchema": {"type": "object", "properties": {}},
                    },
                ]
            },
        }

    if request.get("method") == "tools/call":
        tool_name = request["params"]["name"]
        args = request["params"].get("arguments", {}) or {}

        try:
            if tool_name == "aether_rag_list":
                with _suppress_stdio():
                    indexes = _discover_indexes_current_project()
                return {
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": {"content": [{"type": "text", "text": _safe_json_text(indexes)}]},
                }

            if tool_name == "aether_rag_search":
                index_name = args.get("index_name")
                query = args.get("query")
                if not index_name or not query:
                    return {
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "result": {
                            "content": [{"type": "text", "text": "Error: Both index_name and query are required"}]
                        },
                    }

                with _suppress_stdio():
                    index_path = _resolve_index_path(str(index_name))
                    searcher = AetherRagSearcher(index_path=index_path)

                    results = searcher.search(
                        str(query),
                        top_k=int(args.get("top_k", 5)),
                        complexity=int(args.get("complexity", 32)),
                    )

                show_metadata = bool(args.get("show_metadata", False))
                payload = []
                for r in results:
                    score = getattr(r, "score", None)
                    if score is not None:
                        try:
                            score = float(score)
                        except Exception:
                            pass
                    item = {"score": score, "text": getattr(r, "text", "")}
                    if show_metadata:
                        item["metadata"] = getattr(r, "metadata", None)
                    payload.append(item)

                return {
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": {"content": [{"type": "text", "text": _safe_json_text(payload)}]},
                }

            return {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "result": {"content": [{"type": "text", "text": f"Error: Unknown tool '{tool_name}'"}]},
            }

        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": -1, "message": str(e)},
            }

    return None


def main() -> None:
    for line in sys.stdin:
        try:
            req = json.loads(line.strip())
            resp = handle_request(req)
            if resp is not None:
                print(json.dumps(resp, ensure_ascii=False))
                sys.stdout.flush()
        except Exception as e:
            print(
                json.dumps(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -1, "message": str(e)}},
                    ensure_ascii=False,
                )
            )
            sys.stdout.flush()


if __name__ == "__main__":
    main()
