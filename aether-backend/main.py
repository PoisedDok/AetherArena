"""
Main Entry Point

Unified launcher for Aether Backend services.
Supports running API server, background workers, and watchdogs from a single binary.

@.architecture
Incoming: CLI invocation, process manager --- {argv}
Processing: parse_args(), launch_service() --- {3 jobs: JOB_INITIALIZE_COMPONENT, JOB_LOAD_CONFIG, JOB_SPAWN_PROCESS}
Outgoing: FastAPI, Workers, or Watchdog process --- {service_instance}
"""

import logging
import os
import sys
import argparse
import multiprocessing
from pathlib import Path

# --- THIRD-PARTY TELEMETRY SUPPRESSION ---
# AetherArena claims "no telemetry, analytics, or tracking of any kind."
# Ensure no bundled library phones home before we import anything heavy.
# setdefault() preserves explicit user overrides if set.
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')        # Hugging Face Hub
os.environ.setdefault('HF_HUB_OFFLINE', '0')                   # Allow model downloads, just no telemetry
os.environ.setdefault('TRANSFORMERS_NO_ADVISORY_WARNINGS', '1') # Suppress HF advisory network calls
os.environ.setdefault('LITELLM_TELEMETRY', 'False')            # LiteLLM (BerriAI)
os.environ.setdefault('DO_NOT_TRACK', '1')                     # Generic opt-out (Console Do Not Track)
os.environ.setdefault('SCARF_NO_ANALYTICS', '1')               # Scarf analytics (used by some ML packages)

logger = logging.getLogger(__name__)

# --- DYNAMIC PATH INJECTION (Surgical Coordinator Pattern) ---
# In production, heavy external platforms (supabase, perplexica) are managed 
# externally (Docker/downloaded). We inject the backend root into sys.path 
# to allow the binary to import these external platforms as top-level modules 
# while prioritizing bundled core services (agents, embeddings, etc.).
def _inject_external_service_paths():
    """Inject external service paths into sys.path and PYTHONPATH at runtime."""
    # Priority 1: AETHER_INSTALL_DIR (read-only install dir with services, binaries)
    # In packaged mode, AETHER_BACKEND_ROOT is the writable data dir (no services there).
    # AETHER_INSTALL_DIR is the read-only bundle containing services/.
    install_root = os.getenv("AETHER_INSTALL_DIR")
    
    # Priority 2: AETHER_BACKEND_ROOT (for dev mode where data dir = source tree)
    backend_root = os.getenv("AETHER_BACKEND_ROOT")
    
    # Priority 3: Directory containing the binary (packaged mode fallback)
    if not install_root and not backend_root and getattr(sys, 'frozen', False):
        install_root = str(Path(sys.executable).parent.resolve())
    
    base_services_root = install_root or backend_root or str(Path(__file__).resolve().parent)
    vendored_paths = []
    
    # Inject install dir first (for finding services/)
    if install_root and Path(install_root).exists():
        if install_root not in sys.path:
            sys.path.append(install_root)
        if install_root not in vendored_paths:
            vendored_paths.append(install_root)
        logger.info("Coordinator: Injected install path: %s", install_root)
    
    # Also inject backend root if different (for dev mode)
    if backend_root and backend_root != install_root and Path(backend_root).exists():
        if backend_root not in sys.path:
            sys.path.append(backend_root)
        if backend_root not in vendored_paths:
            vendored_paths.append(backend_root)
        logger.info("Coordinator: Injected data path: %s", backend_root)
            
    # ARCHITECTURAL FIX: Inject vendored paths into sys.path AND PYTHONPATH
    # This ensures Uvicorn subprocesses inherit the same module resolution.
    if base_services_root:
        services_dir = Path(base_services_root) / "services"
        vendored_targets = [
            services_dir / "docling",
            services_dir / "realtime-tts",
            services_dir / "xlwings",
            services_dir / "aether-rag" / "packages" / "aether-rag-core" / "src",
        ]
        
        for target in vendored_targets:
            target_str = str(target)
            if os.path.isdir(target_str):
                if target_str not in sys.path:
                    sys.path.insert(0, target_str)
                if target_str not in vendored_paths:
                    vendored_paths.append(target_str)
                    
        # Update PYTHONPATH so subprocesses (like uvicorn) inherit these paths
        if vendored_paths:
            existing_pythonpath = os.environ.get("PYTHONPATH", "")
            existing_paths = existing_pythonpath.split(os.pathsep) if existing_pythonpath else []
            paths_to_add = [p for p in vendored_paths if p not in existing_paths]
            
            if paths_to_add:
                new_pythonpath = os.pathsep.join(paths_to_add + existing_paths)
                os.environ["PYTHONPATH"] = new_pythonpath
                logger.info("Coordinator: Updated PYTHONPATH with %d vendored paths", len(paths_to_add))
    
    # --- FROZEN BINARY DATA PATH FIXES ---
    if getattr(sys, 'frozen', False):
        _internal = getattr(sys, '_MEIPASS', None)
        if not _internal:
            # ONEDIR mode: _internal is next to the binary
            _internal = str(Path(sys.executable).parent / '_internal')
        
        # NLTK: punkt_tab and other tokenizer data is bundled at _internal/nltk_data/
        # Without this, NLTK tries to download via SSL (fails in sandboxed envs)
        nltk_data_path = os.path.join(_internal, 'nltk_data')
        if os.path.isdir(nltk_data_path):
            os.environ.setdefault('NLTK_DATA', nltk_data_path)
            # Inject into nltk.data.path at first position so nltk.data.find()
            # resolves locally without any network access.
            try:
                import nltk.data
                if nltk_data_path not in nltk.data.path:
                    nltk.data.path.insert(0, nltk_data_path)
            except ImportError:
                pass  # NLTK not yet available, env var will suffice

            # CRITICAL: Monkey-patch nltk.download() to check local data FIRST.
            # nltk.download() unconditionally fetches a remote INDEX via urlopen()
            # before checking if data exists locally. In frozen/sandboxed envs the
            # SSL handshake fails, producing a noisy error even though the data is
            # bundled at _internal/nltk_data/. This patch intercepts the call,
            # checks nltk.data.find() (which uses nltk.data.path — our bundled dir),
            # and returns True immediately if found. Falls through to original on miss.
            try:
                import nltk
                _original_nltk_download = nltk.download
                # Map of resource id → nltk.data.find() lookup path
                _NLTK_RESOURCE_PATHS = {
                    'punkt_tab': 'tokenizers/punkt_tab',
                    'punkt': 'tokenizers/punkt',
                    'averaged_perceptron_tagger': 'taggers/averaged_perceptron_tagger',
                    'averaged_perceptron_tagger_eng': 'taggers/averaged_perceptron_tagger_eng',
                    'stopwords': 'corpora/stopwords',
                    'wordnet': 'corpora/wordnet',
                }
                def _local_first_nltk_download(info_or_id=None, *args, **kwargs):
                    """Check local data availability before remote download."""
                    if info_or_id and isinstance(info_or_id, str):
                        lookup = _NLTK_RESOURCE_PATHS.get(info_or_id)
                        if lookup:
                            try:
                                nltk.data.find(lookup)
                                return True  # Found locally — skip network entirely
                            except LookupError:
                                pass
                    return _original_nltk_download(info_or_id, *args, **kwargs)
                nltk.download = _local_first_nltk_download
            except ImportError:
                pass
            logger.info("Coordinator: NLTK_DATA -> %s", nltk_data_path)

def _augment_system_path():
    """Augment PATH to ensure user-installed tools (node, npm, docker) are found in packaged apps."""
    current_path = os.environ.get("PATH", "")
    existing_paths = current_path.split(os.pathsep) if current_path else []
    
    paths_to_add = [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        str(Path.home() / ".local" / "bin"),
        str(Path.home() / ".cargo" / "bin"),
        str(Path.home() / ".npm-global" / "bin"),
        str(Path.home() / ".docker" / "bin"),
    ]
    
    # Add PyInstaller bundled binaries (uv, uvx)
    if getattr(sys, 'frozen', False):
        _internal = getattr(sys, '_MEIPASS', None) or str(Path(sys.executable).parent / '_internal')
        bundled_bin = os.path.join(_internal, 'bin')
        if os.path.isdir(bundled_bin):
            paths_to_add.insert(0, bundled_bin)
            
    for p in paths_to_add:
        if p not in existing_paths and os.path.isdir(p):
            existing_paths.append(p)
            
    os.environ["PATH"] = os.pathsep.join(existing_paths)

# Run injection before any service imports
_inject_external_service_paths()
_augment_system_path()

def run_api_server():
    import uvicorn
    from config.settings import get_settings
    # Get settings for port configuration
    settings = get_settings()
    
    # Use centralized settings (env overrides already applied via config)
    host = settings.security.bind_host
    port = settings.security.bind_port
    log_level = settings.monitoring.log_level.lower()
    
    logger.info("Starting Aether API Server on %s:%s", host, port)
    
    # Set lifespan timeout via env var (most compatible across uvicorn versions)
    os.environ["UVICORN_TIMEOUT_LIFESPAN"] = "60"
    
    # PYINSTALLER FIX: Import app directly instead of string-based module loading
    # String-based imports ("app:create_app") fail in frozen binaries
    from app import create_app
    app_instance = create_app()
    
    # Run with direct app instance (no factory, no reload)
    # reload=False is CRITICAL for PyInstaller binary (multiprocessing incompatible)
    uvicorn.run(
        app_instance,
        host=host,
        port=port,
        reload=False,
        log_level=log_level
    )

def run_worker():
    logger.info("Starting Aether Background Worker...")
    # PYINSTALLER FIX: Clear arguments before calling delegated main
    if len(sys.argv) > 1:
        # Preserve only the script name and any non-mode flags
        sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != "worker"]
    from workers.__main__ import main as worker_main
    worker_main()

def run_worker_watchdog():
    logger.info("Starting Aether Background Worker Watchdog...")
    # PYINSTALLER FIX: Clear arguments before calling delegated main
    if len(sys.argv) > 1:
        sys.argv = [sys.argv[0]] + [a for a in sys.argv[1:] if a != "worker-watchdog"]
    from core.runtime.workers.job_worker_watchdog import main as watchdog_main
    watchdog_main()

def run_aether_rag_daemon():
    logger.info("Starting Aether-RAG File Indexing Daemon...")
    import asyncio
    from services.daemons.file_indexing.daemon import main as daemon_main
    asyncio.run(daemon_main())

def run_file_indexing_mcp_server():
    logger.info("Starting Aether-RAG File Indexing MCP Server...")
    import asyncio
    from services.daemons.mcp.file_indexing_mcp_server import main as mcp_main
    asyncio.run(mcp_main())

def run_slack_mcp_server():
    logger.info("Starting Native Slack MCP Server...")
    import asyncio
    from services.daemons.mcp.slack_mcp_server import main as mcp_main
    asyncio.run(mcp_main())

def run_telegram_mcp_server():
    logger.info("Starting Native Telegram MCP Server...")
    import asyncio
    from services.daemons.mcp.telegram_mcp_server import main as mcp_main
    asyncio.run(mcp_main())

def run_whatsapp_mcp_server():
    logger.info("Starting Native WhatsApp MCP Server...")
    import asyncio
    from services.daemons.mcp.whatsapp_mcp_server import main as mcp_main
    asyncio.run(mcp_main())

def run_filesystem_mcp_server():
    logger.info("Starting Native Filesystem MCP Server...")
    import asyncio
    from services.daemons.mcp.filesystem_mcp_server import main as mcp_main
    asyncio.run(mcp_main())

def run_searxng_wrapper():
    logger.info("Starting SearXNG Wrapper...")
    import importlib.util
    
    # The SearXNG wrapper lives in scripts/ (not a Python package).
    # Use importlib.util to load it directly from file path.
    backend_root = Path(__file__).parent.resolve()
    wrapper_path = backend_root / "scripts" / "searxng_server_wrapper.py"
    
    # Frozen binary: PyInstaller bundles scripts/ into _MEIPASS/_internal
    if getattr(sys, 'frozen', False) and not wrapper_path.exists():
        wrapper_path = Path(sys._MEIPASS) / "scripts" / "searxng_server_wrapper.py"
    
    if not wrapper_path.exists():
        logger.error("SearXNG wrapper script not found at %s", wrapper_path)
        sys.exit(1)
    
    spec = importlib.util.spec_from_file_location("searxng_server_wrapper", str(wrapper_path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raise SystemExit(module.main())

def run_daemon_manager():
    """Run the daemon manager as a standalone process.
    
    In frozen (PyInstaller) builds, daemon_control.py uses the binary's 
    daemon-manager subcommand instead of spawning python + daemon_manager.py,
    which would fail because sys.executable is the frozen binary, not python.
    
    This process manages 5 background daemons (browser, email, filesystem,
    query_generation, file_indexing) and runs INDEPENDENTLY of the backend.
    It survives backend restarts via start_new_session process detachment.
    """
    logger.info("Starting Daemon Manager...")
    import asyncio
    
    # Duplicate detection (mirrors daemon_manager.py __name__ == "__main__" block)
    from services.daemons.daemon_manager import PID_FILE
    if PID_FILE.exists():
        try:
            existing_pid = int(PID_FILE.read_text().strip())
            try:
                import psutil
                proc = psutil.Process(existing_pid)
                cmdline = ' '.join(proc.cmdline())
                if 'daemon_manager' in cmdline or 'daemon-manager' in cmdline:
                    logger.info("Daemon manager already running (PID: %s), exiting", existing_pid)
                    return
                else:
                    logger.info("Stale PID file (PID %s is not daemon_manager), cleaning up", existing_pid)
                    PID_FILE.unlink()
            except Exception:
                logger.info("Cleaning stale PID file (PID %s not running)", existing_pid)
                PID_FILE.unlink()
        except (OSError, ValueError):
            pass  # PID file unreadable or invalid, proceed with fresh start
    
    from services.daemons.daemon_manager import main as dm_main
    asyncio.run(dm_main())

def run_migrations():
    logger.info("Running Database Migrations...")
    
    # CRITICAL FIX: Load environment variables (including local.env) before running migrations.
    # Without this, POSTGRES_PASSWORD defaults to "postgres", overriding the real DB password
    # and locking out all other Docker services.
    from config.settings import get_settings
    get_settings()
    
    import asyncio
    from data.database.migration_runner import run_migrations as execute_migrations
    
    async def _run():
        # Run migrations
        success = await execute_migrations()
        if not success:
            logger.error("Migrations failed")
            sys.exit(1)
        logger.info("Migrations completed successfully")

    asyncio.run(_run())

def main():
    parser = argparse.ArgumentParser(description="Aether Backend Launcher")
    parser.add_argument(
        "mode",
        choices=["api", "worker", "worker-watchdog", "aether_rag-daemon", "file-indexing-mcp", "slack-mcp", "telegram-mcp", "whatsapp-mcp", "filesystem-mcp", "searxng-wrapper", "daemon-manager", "python-eval", "run-migrations", "orchestrate", "setup-core"],
        default="api",
        nargs="?",
        help="Service mode to run (default: api)"
    )
    parser.add_argument("--code", help="Python code to evaluate (for python-eval mode)")

    # ARCHITECTURAL FIX: If first arg is a path to a .py file, it's likely a misdirected call from dev environment
    # or an old DB record. Map it to the correct mode if possible.
    if len(sys.argv) > 1 and sys.argv[1].endswith(".py"):
        path = sys.argv[1].lower()
        if "mcp_server.py" in path:
            sys.argv[1] = "file-indexing-mcp"
        elif "daemon_manager.py" in path:
            sys.argv[1] = "daemon-manager"
        elif "daemon.py" in path:
            sys.argv[1] = "aether_rag-daemon"
        elif "wrapper.py" in path:
            sys.argv[1] = "searxng-wrapper"

    args, remaining = parser.parse_known_args()

    if args.mode == "api":
        run_api_server()
    elif args.mode == "worker":
        run_worker()
    elif args.mode == "worker-watchdog":
        run_worker_watchdog()
    elif args.mode == "aether_rag-daemon":
        run_aether_rag_daemon()
    elif args.mode == "file-indexing-mcp":
        run_file_indexing_mcp_server()
    elif args.mode == "slack-mcp":
        run_slack_mcp_server()
    elif args.mode == "telegram-mcp":
        run_telegram_mcp_server()
    elif args.mode == "whatsapp-mcp":
        run_whatsapp_mcp_server()
    elif args.mode == "filesystem-mcp":
        run_filesystem_mcp_server()
    elif args.mode == "searxng-wrapper":
        run_searxng_wrapper()
    elif args.mode == "daemon-manager":
        run_daemon_manager()
    elif args.mode == "run-migrations":
        run_migrations()
    elif args.mode == "orchestrate":
        from core.system.orchestrator import main as orchestrator_main
        orchestrator_main(remaining)
    elif args.mode == "setup-core":
        from core.system.setup_engine import main as setup_main
        setup_main()
    elif args.mode == "python-eval":
        if args.code:
            exec(args.code)
        else:
            logger.error("--code required for python-eval mode")

if __name__ == "__main__":
    # Bootstrap logging for CLI output before service-specific config takes over
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    
    # PYINSTALLER FIX: Required for multiprocessing support in frozen binaries
    multiprocessing.freeze_support()
    
    # Handle multiprocessing spawning calls which might bypass argparse correctly
    if len(sys.argv) > 1 and "multiprocessing" in sys.argv[1]:
        # Multiprocessing internally handles this after freeze_support() 
        # but if it leaks to here, we should exit gracefully to avoid argparse error
        sys.exit(0)
        
    main()
