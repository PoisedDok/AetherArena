#!/usr/bin/env python3
"""
@.architecture
Incoming: CLI args + Aether backend config --- {argparse, Settings}
Processing: spawn OI server subprocess, inject tools, manage per-session isolation --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_EXTERNAL_CALL, JOB_LOG}
Outgoing: running OI server process on specified port --- {subprocess, HTTP server}

Open Interpreter Server Wrapper (Aether-owned)

Goal:
- Run an external Open Interpreter server process.
- Ensure per-WebSocket-session conversation isolation (critical for per-chat instances).
- Inject Aether backend tools at runtime.
- Apply Aether-owned system prompt (GURU.yaml) via OI settings.

Usage example:
  python scripts/oi_server_wrapper.py --port 8000 --backend-url http://127.0.0.1:8765 --auth dummy-api-key

Notes:
- This wrapper still runs in a dedicated venv (see scripts/setup_oi_server_venv.sh) to avoid Starlette pin conflicts.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
import threading
import time
from typing import Any, Dict

import httpx
from pathlib import Path

# Backend module path setup — DEVELOPMENT MODE ONLY.
#
# In development, add the backend source tree so we can import
# core.integrations.framework.oi_catalog for tool injection.
#
# In production (PyInstaller build), this wrapper lives at
# _internal/scripts/oi_server_wrapper.py and is spawned by the backend
# as a subprocess under venv-oi Python (NOT the frozen binary).  Because
# it runs under a *separate* interpreter, sys.frozen is always False here.
# We detect the packaged environment via base_library.zip — a definitive
# PyInstaller artifact that only exists inside _internal/.
#
# Adding _internal/ to sys.path would shadow venv-oi packages with
# PyInstaller's stripped stubs (directories containing only .so files
# without __init__.py): uvloop, msgpack, PIL, cryptography, matplotlib,
# lxml, and 59+ other overlapping packages.  This caused:
#   - AttributeError: module 'uvloop' has no attribute 'new_event_loop'
#   - AttributeError: module 'msgpack' has no attribute 'packb'
# Tool injection via OIToolCatalogBridge is not available in packaged
# builds anyway — the import is expected to fail.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
_is_packaged = (
    getattr(sys, "frozen", False)                   # frozen binary (fallback)
    or (BACKEND_ROOT / "base_library.zip").exists()  # PyInstaller artifact
)

if not _is_packaged:
    if str(BACKEND_ROOT) not in sys.path:
        sys.path.insert(0, str(BACKEND_ROOT))

# OIToolCatalogBridge is optional — not available in packaged builds.
OIToolCatalogBridge = None
if not _is_packaged:
    try:
        from core.integrations.framework.oi_catalog import OIToolCatalogBridge  # noqa: E402
    except ImportError:
        pass  # Handled later in main()

logger = logging.getLogger("oi_server_wrapper")


# ═══════════════════════════════════════════════════════════════════════════
# Extracted testable components (module-level for importability)
# ═══════════════════════════════════════════════════════════════════════════


def _patched_run_text_llm(llm, params):
    """
    Corrected run_text_llm — fixes content.replace(language, '') bug.

    OI's original run_text_llm.py line 70 uses content.replace(language, "")
    which globally strips ALL occurrences of the language name from code content.
    For HTML: "<!DOCTYPE html>" becomes "<!DOCTYPE >".
    For Java: "import java.util.List" becomes "import .util.List".

    This version strips the language identifier ONLY from the start of the first
    content chunk (the markdown code block header), using startswith() instead of
    replace().
    """
    if llm.execution_instructions:
        try:
            params["messages"][0][
                "content"
            ] += "\n" + llm.execution_instructions
        except Exception:
            print('params["messages"][0]', params["messages"][0])
            raise

    inside_code_block = False
    accumulated_block = ""
    language = None
    language_header_stripped = False

    for chunk in llm.completions(**params):
        if llm.interpreter.verbose:
            print("Chunk in coding_llm", chunk)

        if "choices" not in chunk or len(chunk["choices"]) == 0:
            continue

        content = chunk["choices"][0]["delta"].get("content", "")

        if content is None:
            continue

        accumulated_block += content

        if accumulated_block.endswith("`"):
            continue

        if "```" in accumulated_block and not inside_code_block:
            inside_code_block = True
            accumulated_block = accumulated_block.split("```")[1]

        if inside_code_block and "```" in accumulated_block:
            return

        if inside_code_block:
            if language is None and "\n" in accumulated_block:
                language = accumulated_block.split("\n")[0]

                if language == "":
                    if llm.interpreter.os is False:
                        language = "python"
                    elif llm.interpreter.os is True:
                        language = "text"
                else:
                    language = "".join(
                        char for char in language if char.isalpha()
                    )

            if language:
                code_content = content
                # FIX: Strip language identifier ONLY from the start
                # of the first content chunk, ONCE.  Never strip from
                # the middle of content or from subsequent chunks.
                if not language_header_stripped:
                    if code_content.startswith(language):
                        code_content = code_content[len(language):]
                    language_header_stripped = True

                yield {
                    "type": "code",
                    "format": language,
                    "content": code_content,
                }

        if not inside_code_block:
            yield {"type": "message", "content": content}


class _HTMLPassthrough:
    """
    Silent HTML language handler for Open Interpreter.

    OI's Terminal rejects languages without a handler with
    "`<lang>` disabled or not supported".  HTML code blocks are
    common in agent output but aren't "executable".

    CRITICAL: Do NOT echo the raw HTML source as output.
    The HTML is already streamed to the frontend as a code artifact
    (role=assistant, type=code, format=html) for display in the
    artifacts viewer.  If the raw HTML is echoed as the computer
    output, OI's LLM sees its own code reflected back, interprets
    it as abnormal feedback, and enters an infinite correction loop
    regenerating HTML over and over.

    Instead, yield a short status message.  This:
      - Gets added to interpreter.messages as computer:console:output
        by _respond_and_store (core.py:410-411)
      - Prevents the empty-output fallback (core.py:333) from firing
        because messages[-1].role IS "computer"
      - Tells the LLM that execution completed successfully so it
        responds with text instead of attempting to "fix" the code
      - Emits output:console directly (no normalizer dependency), mapped to
        "executing" phase by PhaseDetector
    """
    name = "HTML"
    file_extension = "html"
    aliases = ["html", "htm"]

    def __init__(self, computer):
        pass

    def run(self, code):
        """Yield a short status message so OI's respond loop sees
        successful execution and advances instead of retrying.
        The HTML source is already visible in the Code tab.
        
        CRITICAL FIX: We also pass the actual HTML code in a hidden
        `__ui_content` field. The backend stream orchestrator will swap this
        into the content field sent to the frontend, so the frontend OutputViewer
        can render the proper browser page, while the LLM only sees the short
        status message and avoids an infinite correction loop.
        """
        yield {
            "type": "console",
            "format": "output",
            "content": "[HTML executed successfully]",
            "__ui_content": code
        }

    def stop(self):
        pass

    def terminate(self):
        pass


def _apply_settings_via_http(
    server_url: str,
    payload: Dict[str, Any],
    *,
    api_key: str | None = None,
    timeout: float = 10.0,
) -> None:
    url = server_url.rstrip("/") + "/settings"
    headers = {}
    if api_key:
        headers["X-API-KEY"] = api_key
    resp = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"OI server rejected settings ({resp.status_code}): {resp.text}")


async def _wait_for_backend(base_url: str, timeout_seconds: float = 30.0) -> None:
    url = base_url.rstrip("/") + "/v1/health"
    async with httpx.AsyncClient(timeout=5.0) as client:
        end = asyncio.get_event_loop().time() + timeout_seconds
        while asyncio.get_event_loop().time() < end:
            try:
                r = await client.get(url)
                if r.status_code < 400:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
    raise RuntimeError(f"Backend did not become healthy in time: {url}")

def _wait_for_oi_server(server_url: str, timeout_seconds: float = 30.0) -> None:
    heartbeat = server_url.rstrip("/") + "/heartbeat"
    end = time.time() + float(timeout_seconds)
    while time.time() < end:
        try:
            r = httpx.get(heartbeat, timeout=2.0)
            if r.status_code < 400:
                return
        except Exception:
            pass
        time.sleep(0.25)
    raise RuntimeError(f"OI server did not become healthy in time: {heartbeat}")

class _HTTPClientShim:
    def __init__(self, external_service_timeout: float = 10.0) -> None:
        self.external_service_timeout = float(external_service_timeout)

class _SettingsShim:
    def __init__(self, *, base_url: str, config_dir: Path) -> None:
        self.base_url = base_url
        self.config_dir = config_dir
        self.http_client = _HTTPClientShim(10.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="Aether OI server wrapper (legal-clean externalization)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--backend-url", default=None, help="Backend base URL, e.g. http://127.0.0.1:8765")
    parser.add_argument("--auth", default=None, help="Optional OI server auth token")
    parser.add_argument("--chat-id", default=None, help="Associated Chat ID for toolrunner context")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    try:
        # Externalized-only: import Open Interpreter from the venv-oi site-packages.
        from interpreter.core.async_core import AsyncInterpreter  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "Unable to import Open Interpreter server implementation.\n"
            "- Install upstream `open-interpreter` into venv-oi via scripts/setup_oi_server_venv.sh"
        ) from exc

    # ── CRITICAL BUG FIX: Apply run_text_llm monkey-patch ────────────────
    # See _patched_run_text_llm (module-level) for full documentation.
    # ─────────────────────────────────────────────────────────────────────
    try:
        import interpreter.core.llm.llm as _oi_llm_module  # type: ignore
        _oi_llm_module.run_text_llm = _patched_run_text_llm
        logger.info(
            "Patched OI run_text_llm: fixed content.replace(language, '') "
            "corruption bug (all languages)"
        )
    except Exception as patch_exc:
        logger.warning(
            "Failed to patch run_text_llm (HTML/code content may be corrupted): %s",
            patch_exc,
        )
    # ── End run_text_llm patch ───────────────────────────────────────────

    backend_url = (args.backend_url or "").strip()
    if not backend_url:
        raise RuntimeError("backend-url is required (and settings.base_url is empty)")

    # Expose backend URL to the Open Interpreter Python kernel process.
    # The Python tool uses a Jupyter kernel in a separate process; it cannot access in-process objects.
    # We inject a `computer` proxy into that kernel that calls back to this backend via HTTP.
    os.environ["AETHER_BACKEND_URL"] = backend_url.rstrip("/")

    # Auth:
    # - HTTP API uses X-API-KEY checked against INTERPRETER_API_KEY.
    # - WebSocket uses {"auth": "<token>"} checked against same key.
    # This matches the upstream OI server behavior.
    if args.auth:
        os.environ["INTERPRETER_REQUIRE_AUTH"] = "True"
        os.environ["INTERPRETER_API_KEY"] = str(args.auth)
    else:
        os.environ["INTERPRETER_REQUIRE_AUTH"] = "False"

    ai = AsyncInterpreter()

    # -----------------------------------------------------------------------------
    # Aether Compatibility & Security
    # -----------------------------------------------------------------------------
    # On macOS, this entire process is heavily sandboxed via sandbox-exec (Seatbelt)
    # in external_server_pool.py. This allows the agent to retain its native ability
    # to run terminal commands (Shell, Python, etc.) while preventing access to
    # sensitive backend secrets (e.g., LOCAL_ENV_PATH, SSH_DIR).
    
    # CRITICAL: Remove all execution handlers except Python.
    # HTML blocks will be treated as plain text and streamed to frontend as assistant:code artifacts.
    # Shell, JavaScript, and AppleScript handlers MUST be disabled to enforce
    # the execution sandbox and prevent trivial RCE bypasses.
    if hasattr(ai.computer, "terminal") and hasattr(ai.computer.terminal, "languages"):
        original_langs = list(ai.computer.terminal.languages)
        filtered_langs = [
            lang for lang in original_langs
            if getattr(lang, "name", "").lower() == "python"
            or getattr(lang, "__name__", "").lower() == "python"
        ]
        
        if len(filtered_langs) < len(original_langs):
            ai.computer.terminal.languages = filtered_langs
            removed_count = len(original_langs) - len(filtered_langs)
            logger.info("Sanitized terminal: removed %d non-Python handler(s) (enforcing sandbox)", removed_count)
        else:
            logger.warning("No non-Python handlers found to remove")

    # Disable image emission (handled by Aether artifacts pipeline)
    ai.computer.emit_images = False
    logger.info("Disabled OI internal image emission (using Aether artifacts pipeline)")

    # -----------------------------------------------------------------------------
    # Aether-owned Python kernel wiring (NO vendor monkeypatch)
    #
    # Upstream OI's Python execution uses a Jupyter kernel in a separate process and does NOT
    # predefine a `computer` global inside that kernel. Aether agents rely on `computer.<tool>()`.
    #
    # Instead of patching vendor classes globally, we override the active Python language *for this
    # interpreter instance only* by swapping out the Terminal's Python language class. This is a
    # supported extension point (`computer.languages`) and keeps the integration localized.
    # -----------------------------------------------------------------------------
    try:
        from interpreter.core.computer.terminal.languages.python import Python as _VendorPython  # type: ignore

        class _AetherPython(_VendorPython):  # type: ignore
            def __init__(self, computer):  # type: ignore[no-untyped-def]
                super().__init__(computer)
                
                chat_id = getattr(args, "chat_id", "") or ""
                
                code = f"""
import sys as _sys
import os
import json as _json
import httpx

def _aether_audit_hook(event, args):
    if event in ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn"):
        raise PermissionError("Aether Security: Unauthorized subprocess execution.")
    elif event.startswith("ctypes"):
        raise PermissionError("Aether Security: Unauthorized ctypes invocation.")
    
    file_events = ("open", "os.rename", "os.link", "os.symlink", "os.remove", "os.rmdir", "shutil.copyfile", "sqlite3.connect")
    if event in file_events:
        import os as _os
        for arg in args:
            if isinstance(arg, (str, bytes)):
                try:
                    path = arg.decode("utf-8") if isinstance(arg, bytes) else str(arg)
                    path = _os.path.abspath(path).lower()
                except Exception:
                    continue
                
                if ".ssh/" in path or "/.ssh" in path or ".aws/" in path or "/.aws" in path or "local.env" in path or "network/cookies" in path:
                    raise PermissionError("Aether Security: Access to sensitive file blocked.")

try:
    _sys.addaudithook(_aether_audit_hook)
except Exception:
    pass

_AETHER_BACKEND = (os.environ.get("AETHER_BACKEND_URL") or "").rstrip("/")
if not _AETHER_BACKEND:
    raise RuntimeError("AETHER_BACKEND_URL is required for computer proxy")

_TOOLRUNNER = _AETHER_BACKEND + "/v1/toolrunner"
_TOOLRUNNER_EXECUTE = _AETHER_BACKEND + "/v1/execute/tool"
_CHAT_ID = "{chat_id}"

def _emit(result):
    \"\"\"Emit tool result to stdout so OI always captures it.\"\"\"
    try:
        print(_json.dumps(result, indent=2, default=str))
    except Exception:
        print(result)

class _ToolsProxy:
    def __init__(self, base: str):
        self._base = base.rstrip("/")

    def search(self, q: str):
        query = (q or "").strip()
        if not query:
            raise ValueError("q is required")
        with httpx.Client(timeout=30.0) as c:
            r = c.get(self._base + "/search", params={{"q": query}}, headers={{"X-Chat-ID": _CHAT_ID}})
            r.raise_for_status()
            result = r.json()
            _emit(result)
            return result

    def list_categories(self):
        with httpx.Client(timeout=30.0) as c:
            r = c.get(self._base + "/list-categories", headers={{"X-Chat-ID": _CHAT_ID}})
            r.raise_for_status()
            result = r.json()
            _emit(result)
            return result

    def list_tools(self, *, category: str):
        cat = (category or "").strip()
        if not cat:
            raise ValueError("category is required")
        with httpx.Client(timeout=30.0) as c:
            r = c.get(self._base + "/list-tools", params={{"category": cat}}, headers={{"X-Chat-ID": _CHAT_ID}})
            r.raise_for_status()
            result = r.json()
            _emit(result)
            return result

    def get_info(self, *, tool: str):
        t = (tool or "").strip()
        if not t:
            raise ValueError("tool name is required")
        with httpx.Client(timeout=30.0) as c:
            r = c.get(self._base + "/info", params={{"tool": t}}, headers={{"X-Chat-ID": _CHAT_ID}})
            r.raise_for_status()
            result = r.json()
            _emit(result)
            return result

class _ComputerProxy:
    def __init__(self, base: str, execute_url: str):
        self._base = base.rstrip("/")
        self._execute_url = execute_url.rstrip("/")
        self.tools = _ToolsProxy(self._base)

    def list_tools(self, category="Other"):
        return self.tools.list_tools(category=category)

    def list_categories(self):
        return self.tools.list_categories()

    def search_tools(self, q=""):
        return self.tools.search(q=q)

    def __getattr__(self, name: str):
        tool_name = (name or "").strip()
        if not tool_name:
            raise AttributeError(name)

        def _call(*args, **kwargs):
            # Backend toolrunner API is kwargs-only (OpenAPI-derived tools).
            # Timeout increased to 600s for long-running search/research tools.
            with httpx.Client(timeout=600.0) as c:
                r = c.post(
                    self._execute_url,
                    json={{"tool": tool_name, "kwargs": kwargs, "positional": list(args)}},
                    headers={{"X-Chat-ID": _CHAT_ID}}
                )
                try:
                    r.raise_for_status()
                    result = r.json()
                except httpx.HTTPStatusError as e:
                    try:
                        err_data = r.json()
                        err_msg = err_data.get("detail", str(e))
                    except Exception:
                        err_msg = str(e)
                    _emit(f"Tool Execution Error: {{err_msg}}")
                    return f"Tool Execution Error: {{err_msg}}"
                    
                # CRITICAL: OI only captures stdout as console output.
                # Jupyter assignments (answer = tool()) produce NO stdout.
                # Without this print, the agent never sees tool results when
                # using assignment syntax (the pattern taught in system_message).
                # Always emit result to stdout so OI captures it regardless
                # of how the agent writes the code.
                _emit(result)
                return result

        return _call

computer = _ComputerProxy(_TOOLRUNNER, _TOOLRUNNER_EXECUTE)
"""
                # Prime the kernel with the tool proxy. Ignore any console output.
                for _ in super().run(code):
                    pass

            def run(self, code):
                import ast

                # Aether fix: Strip markdown code blocks if the model erroneously included them inside the tool call payload
                if isinstance(code, str):
                    cleaned_code = code.strip()
                    if cleaned_code.startswith("```"):
                        lines = cleaned_code.split("\n")
                        if lines and lines[0].strip().startswith("```"):
                            lines = lines[1:]
                        if lines and lines[-1].strip().startswith("```"):
                            lines = lines[:-1]
                        code = "\n".join(lines).strip()

                try:
                    tree = ast.parse(code)
                    for node in ast.walk(tree):
                        if isinstance(node, (ast.Import, ast.ImportFrom)):
                            module_names = [n.name for n in getattr(node, "names", [])]
                            if hasattr(node, "module") and node.module:
                                module_names.append(node.module)
                            for m in module_names:
                                if m in ("subprocess", "pty", "ctypes"):
                                    yield {"type": "console", "format": "output", "content": f"[Aether Security: Execution refused. As a desktop assistant, use Aether tools instead of raw system commands ({m})]"}
                                    return
                        elif isinstance(node, ast.Call):
                            func_name = ""
                            if isinstance(node.func, ast.Attribute):
                                if isinstance(node.func.value, ast.Name):
                                    func_name = f"{node.func.value.id}.{node.func.attr}"
                            elif isinstance(node.func, ast.Name):
                                func_name = node.func.id
                            
                            if func_name in ("os.system", "eval", "exec", "shutil.rmtree") or func_name.startswith("os.exec") or func_name.startswith("os.spawn") or func_name.startswith("os.posix_spawn"):
                                yield {"type": "console", "format": "output", "content": f"[Aether Security: Execution refused. As a desktop assistant, use Aether tools instead of raw system commands ({func_name})]"}
                                return
                except SyntaxError:
                    pass

                yield from super().run(code)

        # Replace Python language class in-place for this interpreter instance.
        # Terminal.languages is a list of classes; preserve ordering.
        langs = list(getattr(ai.computer.terminal, "languages", []) or [])
        replaced = False
        for i, lang_cls in enumerate(langs):
            if getattr(lang_cls, "name", None) == "Python":
                langs[i] = _AetherPython
                replaced = True
                break
        if not replaced:
            langs.insert(0, _AetherPython)
        # ── HTML passthrough language ──────────────────────────────────────
        # See _HTMLPassthrough (module-level) for full documentation.
        langs.append(_HTMLPassthrough)
        # ── End HTML passthrough ──────────────────────────────────────────

        ai.computer.terminal.languages = langs
        logger.info("Installed Aether Python kernel proxy + HTML passthrough via computer.languages")
    except Exception as exc:
        raise RuntimeError(f"Failed to install Aether Python kernel proxy (computer tools will be broken): {exc}") from exc

    # Run server.
    ai.server.host = args.host
    ai.server.port = args.port

    server_url = f"http://{args.host}:{args.port}"

    stop_event = threading.Event()

    def _run() -> None:
        try:
            ai.server.run(port=args.port)
        except Exception as e:
            logger.error(f"OI server error: {e}")
        finally:
            stop_event.set()

    def signal_handler(sig, frame):
        logger.info(f"Received signal {sig}, initiating graceful shutdown...")
        stop_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    t = threading.Thread(target=_run, daemon=True)
    t.start()

    _wait_for_oi_server(server_url, timeout_seconds=30.0)

    # Fetch CENTRAL runtime settings from backend (includes DB overrides) and apply to OI.
    # This prevents models.toml defaults from overriding user-selected models during per-chat spawn.
    asyncio.run(_wait_for_backend(backend_url, timeout_seconds=90.0))
    settings_url = backend_url.rstrip("/") + "/v1/settings/"
    
    # CRITICAL: Force backend to reload settings from disk by adding cache-busting header
    logger.info("Fetching fresh settings from backend (cache invalidation requested)")
    r = httpx.get(settings_url, timeout=10.0, headers={"Cache-Control": "no-cache"})
    if r.status_code >= 400:
        raise RuntimeError(f"Failed to fetch backend runtime settings ({r.status_code}): {r.text[:300]}")
    backend_settings = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if not isinstance(backend_settings, dict):
        raise RuntimeError("Backend /v1/settings/ returned non-object JSON")

    interpreter_cfg = backend_settings.get("interpreter") or {}
    llm_cfg = backend_settings.get("llm") or {}
    if not isinstance(interpreter_cfg, dict) or not isinstance(llm_cfg, dict):
        raise RuntimeError("Backend /v1/settings/ returned invalid settings shapes")
    
    # DEBUG: Verify system_message content
    system_msg = str(interpreter_cfg.get("system_message") or "")
    logger.info(f"Received system_message: {len(system_msg)} bytes, contains search_web_fast_list={('search_web_fast_list' in system_msg)}, contains quick_search={('quick_search' in system_msg)}")

    provider = str(llm_cfg.get("provider") or "").strip() or "aether_inference"
    model = str(llm_cfg.get("model") or "").strip()
    api_base = str(llm_cfg.get("api_base") or "").strip()
    api_key = str(llm_cfg.get("api_key") or "").strip()
    if not model:
        raise RuntimeError("Backend settings missing llm.model")
    if not api_base:
        raise RuntimeError("Backend settings missing llm.api_base")

    # ── CRITICAL: Set LiteLLM fallback environment variables ─────────
    # LiteLLM's OpenAI provider sometimes loses the per-call api_base
    # on subsequent completion calls (observed: first call succeeds via
    # local inference, subsequent calls silently redirect to api.openai.com
    # and fail with AuthenticationError for api_key="not-needed").
    #
    # Setting OPENAI_API_BASE and OPENAI_API_KEY as environment variables
    # ensures LiteLLM ALWAYS routes to the local inference server, even if
    # the per-call api_base parameter is dropped during retries or
    # subsequent conversation turns.
    #
    # This is safe because ALL LLM calls from this OI server process
    # should go through the Aether inference server.
    os.environ["OPENAI_API_BASE"] = api_base
    os.environ["OPENAI_API_KEY"] = api_key or "not-needed"

    # Litellm requires "openai/" prefix for all local OpenAI-compatible endpoints
    # aether_inference, LM Studio, Ollama all serve OpenAI-compatible APIs
    # Model names like "lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit" become "openai/lmstudio-community/Qwen3-4b-Instruct-2507-MLX-8bit"
    # This tells litellm to use the OpenAI client with the custom api_base
    if provider in ("aether_inference", "openai-compatible", "lmstudio", "ollama") and not model.startswith("openai/"):
        model = f"openai/{model}"

    # FORCED: auto_run must be True in external server mode.
    # External OI servers have no user-facing confirmation UI — code execution
    # safety is handled at Aether's trail layer, not OI's.
    config_auto_run = bool(interpreter_cfg.get("auto_run", True))
    if not config_auto_run:
        logger.warning(
            "auto_run=False in backend config, but external OI server requires auto_run=True "
            "(no OI-level confirmation protocol exists). Forcing auto_run=True."
        )

    payload: Dict[str, Any] = {
        "auto_run": True,  # Always True for external server mode
        "loop": bool(interpreter_cfg.get("loop", False)),
        "offline": bool(interpreter_cfg.get("offline", True)),
        "disable_telemetry": bool(interpreter_cfg.get("disable_telemetry", True)),
        "safe_mode": interpreter_cfg.get("safe_mode", "off"),
        # CRITICAL: Use system_message, NOT custom_instructions
        # OI's respond.py appends custom_instructions to system_message, but system_message is the base.
        # Setting custom_instructions alone doesn't override the default system_message.
        "system_message": system_msg,
        "custom_instructions": "",  # Clear this to avoid double-append
        "llm": {
            "model": model,
            "api_base": api_base,
            "api_key": api_key,
            "context_window": int(llm_cfg.get("context_window", 0) or 0),
            "max_tokens": int(llm_cfg.get("max_tokens", 0) or 0),
            "supports_vision": bool(llm_cfg.get("supports_vision", False)),
        },
    }

    _apply_settings_via_http(
        server_url,
        payload,
        api_key=(str(args.auth) if args.auth else None),
        timeout=10.0,
    )
    logger.info("OI server configured from backend runtime settings at %s (model=%s)", server_url, model)

    # Inject backend tools after the server is up (avoids backend/OI startup deadlock).
    # NOTE: In packaged builds OIToolCatalogBridge may be unavailable (ImportError).
    # The backend's main process re-registers tools via HTTP after OI is reachable,
    # so skipping here is safe -- tools arrive within seconds via register_backend_tools().
    if OIToolCatalogBridge is not None:
        try:
            bridge = OIToolCatalogBridge(None, _SettingsShim(base_url=backend_url, config_dir=(BACKEND_ROOT / "config")))
            stats = bridge.register_with_oi(ai)
            logger.info("Injected backend tools into OI: %s", stats)
        except Exception as exc:
            logger.warning("Failed to inject backend tools into OI (non-fatal, backend will retry): %s", exc)
    else:
        logger.info("OIToolCatalogBridge unavailable (packaged build); skipping in-process tool injection")

    # Signal readiness to the pool (sentinel file).
    # The pool waits for this file before returning the server as "ready" so the backend
    # does not start sending WS chat messages while settings/tools are still being applied.
    ready_sentinel = Path(args.port.__str__()).with_suffix(".ready")
    # Use logs_dir if available, otherwise tmp.
    if os.environ.get("AETHER_LOGS_DIR"):
        ready_sentinel = Path(os.environ["AETHER_LOGS_DIR"]) / f"oi-server-{args.port}.ready"
    else:
        ready_sentinel = Path(BACKEND_ROOT) / "logs" / f"oi-server-{args.port}.ready"
    try:
        ready_sentinel.parent.mkdir(parents=True, exist_ok=True)
        ready_sentinel.write_text(str(time.time()))
        logger.info("Readiness sentinel written: %s", ready_sentinel)
    except Exception as e:
        logger.warning("Failed to write readiness sentinel: %s", e)

    # Watchdog thread: self-terminate if backend disappears
    # We start this AFTER full initialization to avoid race conditions during slow startups.
    def _watchdog() -> None:
        """Self-terminate if backend disappears or stop_event is set."""
        fail_count = 0
        while not stop_event.is_set():
            try:
                # Ping backend health
                # Use a separate client to avoid interference
                resp = httpx.get(backend_url.rstrip("/") + "/v1/health", timeout=5.0)
                if resp.status_code < 400:
                    fail_count = 0
                else:
                    fail_count += 1
            except Exception:
                fail_count += 1
            
            if fail_count >= 10: # ~100 seconds of backend silence (more lenient)
                logger.error("Backend unreachable for too long, initiating self-termination...")
                stop_event.set()
                break
                
            # Wait for event or timeout
            stop_event.wait(timeout=10.0)

    w = threading.Thread(target=_watchdog, daemon=True)
    w.start()

    # Block main thread until stop_event is set or server thread dies.
    try:
        while not stop_event.is_set() and t.is_alive():
            stop_event.wait(timeout=1.0)
    except KeyboardInterrupt:
        pass

    logger.info("Shutting down OI server wrapper")
    
    # Attempt to cleanup the interpreter instance (especially child processes/kernels)
    try:
        if hasattr(ai, "computer") and hasattr(ai.computer, "terminal"):
            # Stop the terminal and its languages (Python kernel)
            if hasattr(ai.computer.terminal, "stop"):
                ai.computer.terminal.stop()
                logger.info("OI terminal stopped")
    except Exception as e:
        logger.debug(f"Error during AI terminal cleanup: {e}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

