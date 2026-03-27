"""
FastAPI Application Factory

Creates and configures the FastAPI application with:
- API versioning
- Middleware (CORS, security, monitoring, error handling)
- Dependency injection setup
- Lifecycle management (startup/shutdown)

@.architecture
Incoming: main.py, config/settings.py, api/v1/router.py, ws/hub.py, api/middleware/*.py --- {Settings object, APIRouter instances, middleware constructors}
Processing: create_app(), startup_event(), shutdown_event(), websocket_endpoint() --- {JOB_CLEANUP_RESOURCE, JOB_DISCOVER_TOOLS, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_CONNECTION, JOB_ORCHESTRATE, JOB_ROUTE}
Outgoing: main.py, Frontend (HTTP/WebSocket) --- {FastAPI application instance, HTTP responses, WebSocket messages}
"""

from core.exceptions import DomainException
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager
import asyncio
import os
import sys
import warnings
import numpy as np
# ARCHITECTURAL FIX: Suppress Keras/NumPy FutureWarning about np.object
# This noise pollutes startup logs and terminal output.
warnings.filterwarnings("ignore", category=FutureWarning, message=".*np.object.*")
if not hasattr(np, "object"):
    np.object = object

from pathlib import Path
import time
from typing import Optional, Any
from importlib import import_module
from config.settings import get_settings
from api.v1.router import api_v1_router
from ws.factory import create_websocket_hub
from application.chat import ChatHistoryService
from api.middleware import (
    create_security_headers_middleware,
    create_rate_limiter_middleware,
    create_error_handler_middleware,
    create_request_context_lifecycle_middleware,
    create_authentication_middleware,
)
from api.dependencies import (
    set_runtime_engine,
    set_cache_client,
    get_cache_client,
    shutdown_omni_service,
    require_local_request,
)
from core.mcp.context import set_mcp_manager
from monitoring import (
    configure_from_preset,
    get_logger,
    initialize_health_checks
)
from data.database.persistence_gateway import SupabasePersistenceGateway
from security.rate_limit import (
    configure_cache_backend,
    configure_rate_limits,
    RateLimitConfig,
    RateLimitStrategy,
)

logger = get_logger(__name__)

# Track startup time for uptime calculation
START_TIME = time.time()

# Tracked background tasks launched during startup (prevents silent exception loss)
_startup_tasks: set[asyncio.Task] = set()


def _track_startup_task(task: asyncio.Task) -> None:
    """Track a startup background task so failures are logged, not silently lost."""
    _startup_tasks.add(task)

    def _on_done(done_task: asyncio.Task) -> None:
        _startup_tasks.discard(done_task)
        if done_task.cancelled():
            return
        exc = done_task.exception()
        if exc:
            logger.error("Startup background task failed: %s", exc, exc_info=exc)

    task.add_done_callback(_on_done)


def _read_proactive_master_enabled() -> bool:
    """Read proactive master switch from runtime config for shutdown decision.

    Used during app shutdown to decide if daemon_manager and inference_server
    should survive (proactive ON) or be killed (proactive OFF).

    Returns False (conservative: kill processes) on any error — including
    corrupt JSON, missing settings, or import failures. This is intentionally
    MORE conservative than the unified reader (which falls back to settings
    defaults). Shutdown must prefer killing to orphaning.

    Uses config_path_from_app_root for D3-consistent path computation, but
    does its own file read with conservative error handling.
    """
    try:
        from config.settings import get_settings
        from config.proactive_config_reader import config_path_from_app_root
        settings = get_settings()
        config_path = config_path_from_app_root(settings.app_root)
        master_enabled = settings.proactive.enabled
        if config_path.exists():
            import json
            with open(config_path, 'r') as f:
                runtime_config = json.load(f)
            master_enabled = runtime_config.get("enabled", master_enabled)
        return bool(master_enabled)
    except (ImportError, AttributeError, OSError, ValueError, KeyError, TypeError):
        # Narrowed catch covering all realistic failure paths:
        #   ImportError    - settings/reader module unavailable during shutdown
        #   AttributeError - settings missing proactive/app_root
        #   OSError        - file read (includes FileNotFoundError, PermissionError)
        #   ValueError     - bad JSON (JSONDecodeError is ValueError subclass)
        #   KeyError       - config dict structure issue
        #   TypeError      - unexpected type during bool() coercion
        # Conservative: return False to kill processes and prevent orphans.
        return False


async def _process_pending_onboarding(database_gateway: SupabasePersistenceGateway, settings: Any) -> None:
    """
    Process consolidated onboarding data from pending_onboarding.json.
    This runs during backend startup (lifespan) after DB connection is established.
    """
    pending_file = settings.app_root / "pending_onboarding.json"
    if not pending_file.exists():
        return

    logger.info("Lifespan: found pending_onboarding.json, processing consolidated configuration...")
    try:
        import json
        with open(pending_file, 'r', encoding='utf-8') as f:
            payload = json.load(f)

        # 1. User Profile
        if "user_profile" in payload:
            from data.database.repositories.preferences import PreferencesRepository
            pref_repo = PreferencesRepository(database_gateway)
            await pref_repo.set_preference("user_profile", payload["user_profile"], "default_user")
            logger.info("Processed user_profile")

        # 2. Legal Acceptance
        if "legal_acceptance" in payload:
            # Re-use pref_repo
            pref_repo = PreferencesRepository(database_gateway)
            await pref_repo.set_preference("legal_acceptance_latest", payload["legal_acceptance"], "default_user")
            logger.info("Processed legal_acceptance")

        # 3. Indexing Locations
        if "indexing_locations" in payload:
            from data.database.repositories.files import FileIndexingRepository
            from services.daemons.file_indexing.async_reindex import ReindexJobManager
            files_repo = FileIndexingRepository(database_gateway)
            job_manager = ReindexJobManager(files_repo)
            
            for loc in payload["indexing_locations"]:
                try:
                    result = await files_repo.create_location({
                        "root_path": loc["path"],
                        "location_name": loc["name"],
                        "location_type": loc["type"],
                        "index_mode": loc.get("index_mode", "combined")
                    })
                    # Automatically trigger a reindex job for the newly created location
                    await job_manager.trigger_reindex_async(result["id"], result["location_name"])
                    logger.info("Created and queued indexing for location: %s", loc["name"])
                except Exception as loc_err:
                    logger.warning("Failed to create location %s: %s", loc["path"], loc_err)
            logger.info("Processed %d indexing_locations", len(payload["indexing_locations"]))

        # 4. Proactive Config
        if "proactive_config" in payload:
            from application.agents.proactive_config_service import ProactiveConfigService
            from data.database.repositories.configuration_repository import ConfigurationRepository
            config_repo = ConfigurationRepository()
            proactive_service = ProactiveConfigService(settings, config_repo)
            proactive_service.update_config(payload["proactive_config"])
            logger.info("Processed proactive_config")

        # 5. Daemon Config
        if "daemon_config" in payload:
            from application.daemons.daemon_service import DaemonService
            from data.database.repositories.daemon_logs import DaemonLogsRepository
            from data.database.repositories.files import FileIndexingRepository
            files_repo = FileIndexingRepository(database_gateway)
            daemon_logs_repo = DaemonLogsRepository(database_gateway)
            daemon_service = DaemonService(settings, files_repo, daemon_logs_repo, database_gateway)
            await daemon_service.update_daemon_config(payload["daemon_config"])
            logger.info("Processed daemon_config")

        # 6. Mark Onboarding Complete in DB
        from data.database.repositories.preferences import PreferencesRepository
        pref_repo = PreferencesRepository(database_gateway)
        await pref_repo.set_preference("onboarding_complete", True, "default_user")
        logger.info("Onboarding marked complete in database")

        # 7. Cleanup
        pending_file.unlink()
        logger.info("Successfully processed and deleted pending_onboarding.json")

    except Exception as e:
        logger.error("Failed to process pending_onboarding.json: %s", e, exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Modern FastAPI lifespan context manager for startup/shutdown.
    
    Handles:
    - Startup: Initialize all services
    - Shutdown: Clean up all resources
    """
    # WebSocket hub and cache client (shared across lifecycle)
    ws_hub = None
    cache_client: Optional[Any] = None
    
    # 0. ARCHITECTURAL FIX: Sync Supabase keys before loading settings
    # This ensures matching JWT secrets between backend and database.
    try:
        from core.config.key_sync import sync_supabase_keys
        sync_supabase_keys()
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Key synchronization failed: {e}")

    # Load settings
    settings = get_settings()
    
    logger.info("=== Application Startup ===")
    
    # CRITICAL: Invalidate all caches to ensure fresh profile/settings load
    try:
        from api.dependencies import shutdown_tool_service, shutdown_runtime_settings_service
        shutdown_tool_service()
        shutdown_runtime_settings_service()
        logger.info("All caches cleared on startup")
    except (ImportError, AttributeError, ValueError) as e:
        logger.warning(f"Failed to invalidate caches on startup: {e}")
    
    database_gateway: Optional[SupabasePersistenceGateway] = None
    runtime_instance: Optional["RuntimeEngine"] = None
    
    redis_settings = getattr(settings, "redis", None)

    if redis_settings and redis_settings.enabled:
        try:
            redis_module = import_module("data.cache.redis")
            RedisCache = getattr(redis_module, "RedisCache")
            cache = RedisCache(
                redis_url=redis_settings.url,
                namespace=redis_settings.namespace,
            )
            connected = await cache.connect()
            if connected:
                cache_client = cache
                set_cache_client(cache_client)
                logger.info("Redis cache initialized")
            else:
                logger.warning("Redis cache unavailable; falling back to in-process state")
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
            logger.warning(f"Failed to initialize Redis cache: {e}")
    
    try:
        # Initialize runtime engine
        logger.info("Initializing runtime engine...")
        from core.runtime.engine import RuntimeEngine
        runtime_instance = RuntimeEngine(settings=settings)
        await runtime_instance.start()
        set_runtime_engine(runtime_instance)
        logger.info("Runtime engine initialized")
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.error(f"Failed to initialize runtime engine: {e}", exc_info=True)
        runtime_instance = None

    # Register backend API tools with Open Interpreter (if runtime available).
    # In external-only mode (AGPL isolation), tools are injected per-chat by oi_server_wrapper.py
    # so this is a fast no-op that just confirms the mode.
    if runtime_instance is not None:
        try:
            tool_result = await runtime_instance.register_backend_apis(app)
            if tool_result.get("skipped"):
                logger.info(
                    "Backend API tool registration: %s",
                    tool_result.get("reason", "skipped"),
                )
            elif tool_result.get("success"):
                logger.info("Backend API tools registered successfully")
            else:
                logger.warning(
                    "Backend API tool registration failed: %s",
                    tool_result.get("error", "unknown error"),
                )
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
            logger.warning(f"Backend API tool registration failed: {e}")
    
    # Initialize database
    try:
        skip_health_check = os.getenv("SKIP_SERVICE_HEALTH_CHECK", "false").lower() in ("true", "1", "yes")
        
        if skip_health_check:
            # ARCHITECTURAL FIX: In degraded mode (first-run, no Docker), skip
            # Supabase initialization entirely.  Docker services are not running,
            # so connecting is guaranteed to fail.  database_gateway stays None —
            # all downstream code handles this via `if database_gateway:` guards.
            # The frontend OnboardingModal guides the user through Docker setup;
            # the backend only needs /health and /v1/setup/* endpoints here.
            logger.warning(
                "SKIP_SERVICE_HEALTH_CHECK enabled — database initialization "
                "deferred (Docker services not available)"
            )
        else:
            logger.info("Initializing infrastructure via SetupService...")
            from application.setup.setup_service import SetupService
            from core.system.process_gateway import ProcessGateway
            from data.database.repositories.setup_state_repository import SetupStateRepository
            from fastapi import HTTPException
            
            process_gateway = ProcessGateway()
            state_repository = SetupStateRepository(settings.app_root)
            
            setup_service = SetupService(
                settings=settings,
                process_gateway=process_gateway,
                state_repository=state_repository
            )
            try:
                # SetupService encapsulates docker verification, supabase init, migrations, and gateways
                result = await setup_service.execute_setup(database_initialized=False)
                
                # Wire up database and repository if present, even in degraded mode.
                if "gateway" in result and "file_repo" in result:
                    from core.system.connection_manager import ConnectionManager
                    database_gateway = result.pop("gateway")
                    logger.info(f"DEBUG: assigned database_gateway to: {database_gateway}")
                    ConnectionManager.get_instance().set_database_gateway(database_gateway)
                    ConnectionManager.get_instance().set_file_indexing_repository(result.pop("file_repo"))

                if result.get("status") == "ok":
                    logger.info("Infrastructure initialization completed successfully.")
                    
                    # Consolidated Persistence: check for and process pending onboarding payload
                    # after DB is connected and healthy.
                    if database_gateway:
                        await _process_pending_onboarding(database_gateway, settings)
                else:
                    logger.warning("Infrastructure initialized with warnings: %s", result.get("errors"))
            except HTTPException as e:
                logger.error("Infrastructure initialization failed: %s. Database features will be unavailable.", e.detail)
                logger.error("Please check Docker Desktop and Supabase logs.")
            except Exception as e:
                logger.error("Infrastructure initialization failed with an unexpected error: %s", e, exc_info=True)
    except (RuntimeError, ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.error(f"Failed to initialize database: {e}", exc_info=True)
    
    # =============================================================================
    # Start Background Services (Non-Blocking)
    # =============================================================================
    # ARCHITECTURAL FIX: Services start immediately and handle missing resources gracefully.
    # No blocking waits - fail fast with clear errors, retry at operation time.
    async def start_background_services():
        try:
            settings = get_settings()
            logger.info("--- Starting Background Services ---")
            logger.info(f"DEBUG: database_gateway inside start_background_services is: {database_gateway}")

            if database_gateway:
                # Seed missing agent configs from prompt templates
                try:
                    from application.agents.agent_seeder import seed_missing_agents
                    await seed_missing_agents(database_gateway, settings)
                    logger.info("Agent configs seeded")
                except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                    logger.warning(f"Agent config seeding failed: {e}")

                # Initialize MCP manager with Supabase (if enabled)
                if settings.integrations.mcp_enabled:
                    logger.info("Initializing MCP manager with Supabase...")
                    from core.mcp.manager import MCPServerManager
                    from core.mcp.database import MCPDatabase
                    from data.database.repositories.mcp import MCPRepository
                    
                    # MCP now uses Supabase SDK (no direct PostgreSQL connection needed)
                    mcp_db = MCPDatabase(MCPRepository(database_gateway))
                    await mcp_db.initialize()
                    
                    mcp_manager = MCPServerManager(mcp_db)
                    await mcp_manager.start()
                    set_mcp_manager(mcp_manager)
                    logger.info("MCP manager initialized with Supabase SDK")
                    
                    # Clean up stale "aether_rag_mcp" duplicate (was registered by legacy
                    # ensure_aether_rag_registered path; file_indexing_mcp is the canonical name).
                    try:
                        stale_aether_rag = await mcp_manager.get_server("aether_rag_mcp")
                        if stale_aether_rag:
                            stale_id = stale_aether_rag.get("id") if isinstance(stale_aether_rag, dict) else getattr(stale_aether_rag, "id", None)
                            if stale_id:
                                await mcp_manager.delete_server(stale_id)
                                logger.info("Removed stale 'aether_rag_mcp' duplicate (canonical: file_indexing_mcp)")
                    except Exception as e:
                        logger.debug(f"aether_rag_mcp cleanup skipped: {e}")
                    
                    # Register File Indexing MCP server (CORE FEATURE)
                    try:
                        file_indexing_enabled = getattr(settings.integrations, "file_indexing_enabled", True)
                        if file_indexing_enabled:
                            # 1. Prepare command and arguments based on environment
                            backend_url = getattr(settings.integrations, "file_indexing_backend_url", None) or getattr(settings, "base_url", None)
                            env_vars = {}
                            if backend_url:
                                env_vars["INTEGRATION_FILE_INDEXING_BACKEND_URL"] = backend_url

                            # Robust launching: use native binary mode in production
                            if getattr(sys, 'frozen', False) or os.environ.get("AETHER_PACKAGED") == "true":
                                # In frozen mode, sys.executable is the aether-hub binary
                                cmd = sys.executable
                                args = ["file-indexing-mcp"]
                                logger.info(f"Using frozen MCP command: {cmd} {args}")
                            else:
                                mcp_server_path = Path(__file__).parent / "services" / "daemons" / "mcp" / "file_indexing_mcp_server.py"
                                cmd = sys.executable
                                args = [str(mcp_server_path)]
                                logger.info(f"Using dev MCP command: {cmd} {args}")

                            # 2. Register or update server
                            existing = await mcp_manager.get_server("file_indexing_mcp")
                            if not existing:
                                logger.info("Registering File Indexing MCP server...")
                                server_record = await mcp_manager.register_server(
                                    name="file_indexing_mcp",
                                    display_name="File Indexing MCP",
                                    server_type="local",
                                    config={
                                        "command": cmd,
                                        "args": args,
                                        "env": env_vars,
                                    },
                                    description="Search indexed files using semantic file search",
                                    auto_start=True,
                                    enabled=True,
                                )
                                logger.info(f"File Indexing MCP registered: {server_record['name'] if isinstance(server_record, dict) and 'name' in server_record else 'file_indexing_mcp'}")
                            else:
                                # ARCHITECTURAL FIX: Always update command/args to match current environment (frozen vs dev)
                                # This prevents old DB records from pointing to wrong paths.
                                await mcp_manager.update_server(
                                    existing["id"] if isinstance(existing, dict) else existing.id,
                                    config={
                                        "command": cmd,
                                        "args": args,
                                        "env": env_vars,
                                    }
                                )
                                logger.info("File Indexing MCP configuration updated")
                                logger.info("File Indexing MCP registration updated for current environment")
                        else:
                            logger.info("File Indexing MCP disabled in settings")
                    except Exception as e:
                        logger.error(f"Core Service Failure: File Indexing MCP registration failed: {e}")

                    # Register Native MCP servers
                    try:
                        mcp_daemons = {
                            "filesystem_mcp": {
                                "display_name": "Filesystem Integration",
                                "description": "Native filesystem access for listing directories and finding files.",
                                "script": "filesystem_mcp_server.py"
                            },
                            "slack_mcp": {
                                "display_name": "Slack Integration",
                                "description": "Native Slack connector for reading channels and messages.",
                                "script": "slack_mcp_server.py"
                            },
                            "telegram_mcp": {
                                "display_name": "Telegram Integration",
                                "description": "Native Telegram MTProto connector for personal chats.",
                                "script": "telegram_mcp_server.py"
                            },
                            "whatsapp_mcp": {
                                "display_name": "WhatsApp Integration",
                                "description": "Native WhatsApp Web connector via QR code.",
                                "script": "whatsapp_mcp_server.py"
                            }
                        }

                        for m_name, m_info in mcp_daemons.items():
                            existing_m = await mcp_manager.get_server(m_name)
                            
                            # Build the executable path
                            if getattr(sys, 'frozen', False) or os.environ.get("AETHER_PACKAGED") == "true":
                                m_cmd = sys.executable
                                m_args = [m_name.replace("_", "-")]
                            else:
                                m_script_path = Path(__file__).parent / "services" / "daemons" / "mcp" / m_info["script"]
                                m_cmd = sys.executable
                                m_args = [str(m_script_path)]

                            if not existing_m:
                                logger.info(f"Registering native {m_info['display_name']} server...")
                                # Enable filesystem_mcp by default, others disabled
                                is_filesystem = m_name == "filesystem_mcp"
                                await mcp_manager.register_server(
                                    name=m_name,
                                    display_name=m_info["display_name"],
                                    server_type="local",
                                    config={
                                        "command": m_cmd,
                                        "args": m_args,
                                        "env": {},
                                    },
                                    description=m_info["description"],
                                    auto_start=True,
                                    enabled=is_filesystem,
                                )
                            else:
                                # Only update the command, args, and ensure auto_start is true. Preserve the user's env vars.
                                current_config = existing_m.get("config", {}) if isinstance(existing_m, dict) else getattr(existing_m, "config", {})
                                current_env = current_config.get("env", {})
                                await mcp_manager.update_server(
                                    existing_m["id"] if isinstance(existing_m, dict) else existing_m.id,
                                    auto_start=True,
                                    config={
                                        "command": m_cmd,
                                        "args": m_args,
                                        "env": current_env,
                                    }
                                )
                    except Exception as e:
                        logger.error(f"Failed to seed Native Messaging MCPs: {e}")

                # Verify Docling health (only if enabled)
                if settings.integrations.docling_enabled:
                    try:
                        from core.integrations.providers.docling import docling_health
                        docling_status = docling_health()
                        if docling_status.get("healthy"):
                            logger.info(f"Docling service healthy (version: {docling_status.get('version', 'unknown')})")
                        else:
                            logger.warning(f"Docling service unhealthy: {docling_status.get('error', 'unknown')}")
                    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                        logger.warning(f"Docling health check failed: {e}")

                # Cleanup stale reindex jobs and start in-process reindex poller
                try:
                    from data.database.repositories.files import FileIndexingRepository
                    from services.daemons.file_indexing.async_reindex import ReindexJobManager, start_background_poller
                    files_repo = FileIndexingRepository(database_gateway)
                    job_manager = ReindexJobManager(files_repo)
                    await job_manager.cleanup_stale_statuses()

                    # Start in-process reindex job poller (fallback for when
                    # the external launchd daemon is not running). Runs inside
                    # the FastAPI process and picks up queued jobs every 15s.
                    poller_task = start_background_poller(files_repo, poll_interval=15)
                    _track_startup_task(poller_task)
                    logger.info("In-process reindex job poller started")
                except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                    logger.warning(f"Failed to cleanup stale reindex statuses / start poller: {e}")

            # Start Agent Scheduler (APScheduler for cron jobs)
            # Guard: scheduler requires database gateway for creating job records.
            # In degraded mode (first-run, no Docker), skip — scheduler is useless without DB.
            if database_gateway:
                try:
                    logger.info("Starting agent scheduler...")
                    from workers.scheduler import start_scheduler
                    await start_scheduler(database_gateway)
                    logger.info("Agent scheduler started")
                except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                    logger.warning(f"Failed to start agent scheduler (non-critical): {e}")

            # Start Proactive Agent Worker (DeepPlanning Phase 2)
            try:
                logger.info("Starting proactive agent worker...")
                from workers.handlers.proactive_agent_handler import ProactiveAgentWorker
                # Use base_url for backend communication
                backend_url = settings.base_url or f"http://localhost:{settings.port}"
                # Get WebSocket hub reference for Phase 3 notifications
                websocket_hub = getattr(app.state, "websocket_hub", None)
                # Pass settings for config integration (NO HARDCODING)
                worker = ProactiveAgentWorker(
                    app_root=settings.app_root,
                    backend_url=backend_url,
                    settings=settings,  # Central config integration
                    websocket_hub=websocket_hub,  # Phase 3: WebSocket notifications
                    # Hub may not be initialized yet; worker resolves lazily on emit.
                    websocket_hub_getter=lambda: getattr(app.state, "websocket_hub", None),
                )
                _track_startup_task(asyncio.create_task(worker.start()))
                logger.info("Proactive agent worker started")
            except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
                logger.error(f"Failed to start proactive agent worker: {e}", exc_info=True)

            # NOTE: Proactive daemons now start immediately in main lifespan (moved above)
            # This ensures user activity monitoring begins instantly, not delayed by model downloads

            logger.info("--- Background Services Started ---")
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
            logger.error(f"CRITICAL: Background service initialization failed: {e}", exc_info=True)

    # =========================================================================
    # CRITICAL FIX: Start proactive daemons immediately after normal startup.
    # In onboarding setup mode, keep them stopped until post-onboarding restart.
    # =========================================================================
    # Daemons monitor user activity and must start with the backend, not wait
    # for model downloads which could take minutes/hours on first run.
    onboarding_setup_mode = False
    try:
        if settings.proactive and hasattr(settings.proactive, 'daemons'):
            logger.info("Ensuring proactive source daemons are running...")
            from services.daemons.daemon_control import (
                ensure_daemons_running,
                is_onboarding_setup_mode,
            )

            onboarding_setup_mode = is_onboarding_setup_mode()
            if onboarding_setup_mode:
                logger.info(
                    "Onboarding setup mode detected; proactive daemons remain stopped until restart"
                )

            daemon_started = await ensure_daemons_running(settings)
            if daemon_started:
                logger.info("Proactive daemon manager ready")
            else:
                logger.warning("Failed to start daemon manager")
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.error(f"Failed to manage proactive daemons: {e}", exc_info=True)

    # Keep daemon-manager alive after startup without forcing periodic reloads.
    try:
        proactive_daemons = getattr(getattr(settings, "proactive", None), "daemons", None)
        supervisor_enabled = bool(getattr(proactive_daemons, "supervisor_enabled", False))
        auto_restart_enabled = bool(getattr(proactive_daemons, "supervisor_auto_restart", False))
        supervisor_interval = max(
            5,
            int(getattr(proactive_daemons, "supervisor_check_interval_seconds", 60)),
        )

        if onboarding_setup_mode:
            logger.info("Skipping daemon-manager supervisor during onboarding setup mode")
        elif supervisor_enabled and auto_restart_enabled:
            from services.daemons.daemon_control import ensure_daemon_manager_healthy

            async def _daemon_manager_supervisor_loop() -> None:
                logger.info(
                    "Daemon-manager supervisor loop started (interval=%ss)",
                    supervisor_interval,
                )
                import random
                consecutive_failures = 0
                max_backoff = 300  # 5 minutes
                
                while True:
                    try:
                        await ensure_daemon_manager_healthy(settings)
                        consecutive_failures = 0  # reset on success
                        await asyncio.sleep(supervisor_interval)
                    except asyncio.CancelledError:
                        logger.info("Daemon-manager supervisor loop stopped")
                        raise
                    except Exception as supervisor_error:  # noqa: BLE001 -- supervisor loop must catch all exceptions to prevent silent crash
                        consecutive_failures += 1
                        backoff = min(max_backoff, supervisor_interval * (2 ** (consecutive_failures - 1)))
                        jitter = random.uniform(0, 0.1 * backoff)
                        sleep_time = backoff + jitter
                        
                        logger.warning(
                            "Daemon-manager supervisor cycle failed (attempt %d): %s. Backing off for %.1fs",
                            consecutive_failures,
                            supervisor_error,
                            sleep_time
                        )
                        await asyncio.sleep(sleep_time)

            _track_startup_task(asyncio.create_task(_daemon_manager_supervisor_loop()))
        else:
            logger.info("Daemon-manager supervisor disabled by config")
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Failed to start daemon-manager supervisor: {e}")

    # =========================================================================
    # Aether Inference: ensure inference server is running
    # =========================================================================
    # Inference is a shared resource (chat, manual queries, proactive daemons).
    # It starts unconditionally and is killed only during app shutdown.
    # The proactive master switch controls daemons, not inference.
    try:
        from services.aether_inference.inference_control import ensure_inference_running
        inference_ok = await ensure_inference_running()
        if inference_ok:
            logger.info("Aether Inference server ready")
        else:
            logger.info("Aether Inference server not started (disabled, no venv, or auto_start=false)")
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Inference server startup failed (non-fatal): {e}")

    # Launch background services immediately (non-blocking, tracked for error logging)
    _track_startup_task(asyncio.create_task(start_background_services()))

    history_service: Optional[ChatHistoryService] = None
    if database_gateway is not None:
        try:
            history_service = ChatHistoryService(database_gateway)
            logger.info("Chat history service initialized")
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as history_error:
            history_service = None
            logger.warning(f"Failed to initialize chat history service: {history_error}")

    # Optional wiring: global memory injection service for WS + context viewer.
    memory_service: Optional[Any] = None
    if database_gateway is not None:
        try:
            from data.database.uow import SupabaseUnitOfWork
            from application.chat.memory_service import MemoryService
            uow = SupabaseUnitOfWork(database_gateway, context={})
            memory_service = MemoryService(uow, settings)
            logger.info("Memory service initialized")
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as mem_error:
            memory_service = None
            logger.warning(f"Failed to initialize memory service: {mem_error}")

    # Optional wiring: TTS integration for WS handsfree mode (pass into WS layer; avoid WS importing integrations).
    tts_integration: Optional[Any] = None
    try:
        from core.integrations.libraries.tts import get_tts_integration
        tts_integration = get_tts_integration()
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as tts_error:
        tts_integration = None
        logger.warning(f"Failed to initialize TTS integration: {tts_error}")

    if runtime_instance is not None:
        try:
            logger.info("Initializing WebSocket hub...")
            ws_hub = await create_websocket_hub(
                runtime=runtime_instance,
                cache_client=cache_client,
                redis_settings=redis_settings,
                history_service=history_service,
                database_gateway=database_gateway,
                settings=settings,
                memory_service=memory_service,
                tts_integration=tts_integration,
            )
            logger.info("WebSocket hub initialized")
        except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as hub_error:
            ws_hub = None
            logger.error(f"Failed to initialize WebSocket hub: {hub_error}", exc_info=True)
    else:
        logger.error("Runtime engine unavailable; WebSocket hub not initialized")
    
    app.state.websocket_hub = ws_hub

    if cache_client:
        try:
            configure_cache_backend(
                cache_client,
                namespace=f"{redis_settings.namespace}:rate",
                bucket_ttl=redis_settings.rate_limit_ttl_seconds,
            )
            logger.info("Rate limiter configured for Redis backend")
        except (ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
            logger.warning(f"Failed to configure Redis-backed rate limiting: {e}")
    
    try:
        # Initialize health checks and register components
        logger.info("Initializing health checks...")
        from api.dependencies import get_runtime_engine, get_mcp_manager
        
        runtime_instance = None
        try:
            runtime_instance = get_runtime_engine()
        except (HTTPException, DomainException):
            runtime_instance = None
        
        mcp_instance = get_mcp_manager()
        
        initialize_health_checks(
            runtime=runtime_instance,
            integration_loader=None,
            database=database_gateway,
            mcp_manager=mcp_instance,
            cache=cache_client,
        )
        logger.info("Health checks initialized")
        
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Health check initialization failed: {e}")
    
    # =============================================================================
    # Generate Backend Tools Registry YAML for OI
    # =============================================================================
    try:
        logger.info("Generating backend_tools_registry.yaml for OI...")
        from core.integrations.framework import generate_backend_tools_yaml
        
        success = generate_backend_tools_yaml(
            fastapi_app=app,
            settings=settings
        )
        
        if success:
            logger.info("backend_tools_registry.yaml generated successfully")
            logger.info(f"   Location: {settings.config_dir / 'backend_tools_registry.yaml'}")
            logger.info("   OI will load this on next initialization")
        else:
            logger.warning("Failed to generate backend_tools_registry.yaml")
            
    except (ImportError, ConnectionError, TimeoutError, OSError, ValueError, KeyError) as e:
        logger.warning(f"Backend tools YAML generation failed (non-critical): {e}", exc_info=True)
    
    # NOTE: Stale reindex cleanup and agent scheduler start are handled inside
    # start_background_services() (launched above via asyncio.create_task).
    # Do NOT duplicate them here -- double-starting APScheduler causes duplicate cron executions.
    
    logger.info("=== Startup Complete ===")
    
    # Yield control to the application (FastAPI runs here)
    yield
    
    # === SHUTDOWN ===
    logger.info("=== Application Shutdown ===")

    # Cancel tracked startup background tasks
    if _startup_tasks:
        for task in list(_startup_tasks):
            task.cancel()
        await asyncio.gather(*list(_startup_tasks), return_exceptions=True)
        _startup_tasks.clear()
    
    # CRITICAL: Clear all caches on shutdown for fresh restart
    try:
        from api.dependencies import shutdown_tool_service, shutdown_runtime_settings_service
        shutdown_tool_service()
        shutdown_runtime_settings_service()
        logger.info("All caches cleared on shutdown")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.warning(f"Failed to invalidate caches on shutdown: {e}")
    
    try:
        websocket_hub = getattr(app.state, "websocket_hub", None)
        if websocket_hub and hasattr(websocket_hub, "router"):
            router = websocket_hub.router
            if router and hasattr(router, "shutdown"):
                await router.shutdown()
        if websocket_hub and hasattr(websocket_hub, "shutdown"):
            await websocket_hub.shutdown()
            logger.info("WebSocket hub shutdown")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error shutting down WebSocket hub: {e}")
    
    try:
        # Stop runtime engine
        from api.dependencies import get_runtime_engine
        runtime = get_runtime_engine()
        if runtime:
            await runtime.stop()
            logger.info("Runtime engine stopped")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error stopping runtime: {e}")
    
    try:
        cache = get_cache_client()
        if cache and cache.is_connected():
            await cache.disconnect()
            set_cache_client(None)
            logger.info("Redis cache disconnected")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error disconnecting Redis cache: {e}")

    # LIFECYCLE: Conditionally stop detached background processes on app shutdown.
    # Both daemon_manager and inference_server run as detached daemons
    # (start_new_session=True) in their own process groups, so the Electron
    # shutdown (kill -backendProcess.pid) does NOT reach them.
    #
    # CONDITIONAL SURVIVAL (matches start_production.sh daemon preservation):
    #   proactive ENABLED  → Both daemons and inference SURVIVE shutdown.
    #                        Next app launch reconnects instantly via PID files
    #                        (no cold-start delay, models stay loaded).
    #   proactive DISABLED → Both are killed. No orphan processes.
    #                        User expects a clean machine state.
    #
    # This is the ONLY place inference_server is killed. The proactive master
    # switch (PATCH /v1/proactive/config) controls daemons only — inference
    # survives toggle-off because it serves multiple consumers (chat, manual
    # queries, etc.). It is killed here only when proactive is disabled.
    proactive_master_on = _read_proactive_master_enabled()
    logger.info("Shutdown: proactive master=%s", proactive_master_on)

    try:
        from services.aether_inference.inference_control import inference_shutdown

        if proactive_master_on:
            # Proactive enabled: let daemons + inference survive for instant
            # reconnect on next launch. Dispose manager singleton only.
            await inference_shutdown(stop_server=False)
            logger.info(
                "Inference server preserved (proactive enabled, will reconnect on next launch)"
            )
            logger.info(
                "Daemon manager preserved (proactive enabled, will reconnect on next launch)"
            )
        else:
            # Proactive disabled: kill everything to prevent orphan processes.
            # Run both in parallel via asyncio.gather to:
            #   1. Avoid blocking the event loop (stop_daemon_manager is synchronous)
            #   2. Fit within the 15s Electron shutdown budget
            from services.daemons.daemon_control import stop_daemon_manager

            async def _stop_daemons():
                await asyncio.to_thread(stop_daemon_manager)
                logger.info("Proactive daemon manager stopped")

            async def _stop_inference():
                await inference_shutdown(stop_server=True)
                logger.info("Inference server stopped (no orphan processes)")

            # CRITICAL: Enforce timeout to fit within 15s Electron shutdown budget.
            # If either stop_daemon_manager() or inference_shutdown() hangs
            # (zombie process, unresponsive server), we must not block forever.
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(
                        _stop_daemons(),
                        _stop_inference(),
                        return_exceptions=True,
                    ),
                    timeout=12.0,  # Leave 3s buffer for remaining shutdown steps
                )
                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        name = "daemon manager" if i == 0 else "inference server"
                        logger.warning(f"Background process shutdown ({name}): {result}")
            except asyncio.TimeoutError:
                logger.warning(
                    "Background process shutdown timed out after 12s — "
                    "Electron will force-kill remaining processes"
                )
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.warning(f"Background process shutdown: {e}")

    try:
        # Stop agent scheduler
        from workers.scheduler import shutdown_scheduler
        await shutdown_scheduler()
        logger.info("Agent scheduler stopped")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error stopping agent scheduler: {e}")
    
    try:
        # Stop MCP manager
        from api.dependencies import get_mcp_manager
        mcp_manager = get_mcp_manager()
        if mcp_manager:
            await mcp_manager.stop()
            logger.info("MCP manager stopped")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error stopping MCP manager: {e}")
    
    try:
        from data.network.http_client import close_http_client
        await close_http_client()
        logger.info("Global HTTP client closed")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error closing HTTP client: {e}")

    try:
        # Close Supabase connection
        from core.system.connection_manager import ConnectionManager
        db_conn = ConnectionManager.get_instance().get_database_gateway()
        if db_conn is not None:
            if hasattr(db_conn, 'dispose'):
                await db_conn.dispose()
            logger.info("Supabase client disposed")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error disposing Supabase client: {e}")

    try:
        await shutdown_omni_service()
        logger.info("Omni service shut down")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error shutting down Omni service: {e}")
    
    # CRITICAL FIX: Cleanup ML models (VAD, STT, WakeWord) - release GPU/CPU memory
    try:
        websocket_hub = getattr(app.state, "websocket_hub", None)
        if websocket_hub and hasattr(websocket_hub, 'router'):
            router = websocket_hub.router
            if hasattr(router, '_audio_handler') and router._audio_handler:
                audio_handler = router._audio_handler
                if hasattr(audio_handler, '_audio_processor') and audio_handler._audio_processor:
                    audio_processor = audio_handler._audio_processor
                    if hasattr(audio_processor, 'cleanup'):
                        audio_processor.cleanup()
                        logger.info("ML models cleaned up (VAD, STT, WakeWord memory released)")
    except Exception as e:  # Broad catch: shutdown must complete all cleanup steps
        logger.error(f"Error cleaning up ML models: {e}")

    # NOTE: Docker mesh teardown is owned by the shell script orchestrators
    # (start_production.sh / start_dev.sh → docker_mesh_down()).
    # The backend does NOT manage Docker lifecycle — the scripts do.
    # See start_production.sh::graceful_shutdown() which runs docker_mesh_down()
    # as PRIORITY 1 in parallel with backend stop.

    logger.info("=== Shutdown Complete ===")


def create_app() -> FastAPI:
    """
    Create and configure FastAPI application.
    
    Returns:
        FastAPI: Configured application instance
    """
    # Set backend root path as environment variable for all subprocesses/modules.
    # CRITICAL: Do NOT override if already set by start_production.sh (which sets it
    # to the writable DATA_DIR, not the read-only bundle directory).
    if "AETHER_BACKEND_ROOT" not in os.environ:
        backend_root = Path(__file__).parent.resolve()
        os.environ["AETHER_BACKEND_ROOT"] = str(backend_root)
    
    # Load settings (static during app initialization)
    # Dynamic settings are loaded later by runtime coordinator after DB init
    settings = get_settings()
    
    # Configure logging based on environment
    # Always write to a log file in addition to console — ensures logs survive
    # even if stdout is not redirected (e.g. direct binary launch outside shell script).
    from config.settings import get_app_root as _get_app_root
    _log_dir = _get_app_root() / "logs"
    _log_dir.mkdir(parents=True, exist_ok=True)
    _app_log_file = _log_dir / "backend.log"

    if settings.environment == "production":
        # FIX: Disable console handler in production.
        # start_production.sh redirects stdout to backend.log via shell redirect.
        # The FileHandler ALSO writes to backend.log. With both active, every
        # line appears twice. Console is only useful for dev (terminal output).
        configure_from_preset("production", log_file=_app_log_file, enable_console=False)
    elif settings.environment == "test":
        configure_from_preset("testing")
    else:
        configure_from_preset("development", log_file=_app_log_file)
    
    logger.info(f"Creating Aether Backend application (environment: {settings.environment})")
    
    # Create FastAPI app with comprehensive metadata and lifespan
    app = FastAPI(
        lifespan=lifespan,
        title=settings.app_name,
        version=settings.app_version,
        description="""
# Aether AI Backend - Production Ready API

Professional AI assistant platform with comprehensive capabilities including:

## Core Features
- **Chat & Messaging**: Real-time AI chat with streaming responses, session management, and history
- **Model Context Protocol (MCP)**: Dynamic tool discovery and execution from local and remote servers
- **Memory Management**: Semantic memory storage and retrieval with vector search
- **File Indexing**: On-device file search and retrieval using semantic search
- **Document Processing**: OCR, document parsing, and content extraction via Docling
- **Excel Automation**: XLWings integration for spreadsheet manipulation
- **Vision Processing**: Omni (screen tools) for screenshot capture and screen analysis via configured VLM
- **Web Search**: Perplexica and SearXNG integration for real-time information
- **Code Execution**: Python notebook runtime and shell command execution

## Architecture
- **WebSocket Support**: Real-time bidirectional communication for streaming
- **RESTful API**: Comprehensive HTTP endpoints for all operations
- **Authentication**: JWT-based authentication with configurable public endpoints
- **Rate Limiting**: Intelligent rate limiting with tier-based controls
- **Health Checks**: Kubernetes-ready health, readiness, and liveness probes
- **Monitoring**: Prometheus metrics, structured logging, and distributed tracing

## API Documentation
- **Swagger UI**: Interactive API documentation at `/docs`
- **ReDoc**: Alternative documentation at `/redoc`
- **Programmatic Access**: Machine-readable docs at `/v1/docs`
- **OpenAPI Spec**: Full specification at `/v1/docs/openapi`

## Getting Started
1. Check system health: `GET /health`
2. List available models: `GET /v1/models`
3. Send a chat message: `POST /v1/create/chat`
4. Explore API documentation: `GET /v1/docs`

## Support
For issues, questions, or feature requests, contact info@aetherinc.xyz
        """,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        redirect_slashes=False,  # Disable automatic trailing slash redirect
        contact={
            "name": "AetherArena Support",
            "email": "info@aetherinc.xyz"
        },
        license_info={
            "name": "BUSL-1.1",
            "identifier": "BUSL-1.1"
        },
        openapi_tags=[
            {"name": "health", "description": "Health check and system status endpoints"},
            {"name": "api-documentation", "description": "API documentation and metadata endpoints"},
            {"name": "chat", "description": "Chat messaging and streaming endpoints"},
            {"name": "mcp", "description": "Model Context Protocol server management and tool execution"},
            {"name": "models", "description": "LLM model discovery and capabilities"},
            {"name": "settings", "description": "System settings and configuration"},
            {"name": "memories", "description": "Memory management and semantic search"},
            {"name": "files", "description": "File indexing and semantic search"},
            {"name": "storage", "description": "Chat history and persistent storage"},
            {"name": "omni", "description": "Omni screen tools (screenshot + vision analysis)"},
            {"name": "notebook", "description": "Python code execution runtime"},
            {"name": "xlwings", "description": "Excel spreadsheet automation"},
            {"name": "tts", "description": "Text-to-speech synthesis"},
            {"name": "llm", "description": "LLM proxy and routing"},
            {"name": "profiles", "description": "User profiles and preferences"},
            {"name": "skills", "description": "Custom skills and tool management"},
            {"name": "terminal", "description": "Terminal and shell command execution"},
            {"name": "services", "description": "Service status and monitoring"},
            {"name": "backends", "description": "Backend service registry and management"},
            {"name": "context", "description": "Context management and cross-chat references"}
        ]
    )
    
    
    # Configure dynamic rate limit tiers before middleware instantiation
    if settings.security.rate_limit_tiers:
        tier_map = {}
        for tier in settings.security.rate_limit_tiers:
            try:
                strategy = RateLimitStrategy(tier.strategy)
            except ValueError:
                strategy = RateLimitStrategy.PER_IP
            tier_map[tier.name] = RateLimitConfig(
                requests_per_window=tier.requests_per_window,
                window_seconds=tier.window_seconds,
                burst_size=tier.burst_size,
                strategy=strategy,
            )
        if tier_map:
            configure_rate_limits(tier_map)
    
    # ==========================================================================
    # Middleware Configuration
    # ==========================================================================
    
    # Middleware ordering (outermost last due to FastAPI/Starlette stacking):
    # SecurityHeaders -> CORS -> RequestContextLifecycle -> ErrorHandler -> RateLimiter -> Authentication -> routes
    #
    # This ensures:
    # - CORS + security headers apply to 401/429/500 responses.
    # - Request context cleanup runs even if auth rejects early.

    # Authentication middleware (innermost gate before routes)
    middleware_class, middleware_kwargs = create_authentication_middleware(
        enabled=settings.security.auth_enabled,
        public_patterns=tuple(settings.security.public_paths or []),
        settings=settings,
    )
    app.add_middleware(middleware_class, **middleware_kwargs)

    # Rate limiter middleware
    if settings.security.rate_limit_enabled:
        tier_overrides = [
            (rule.pattern, rule.tier) for rule in settings.security.rate_limit_rules
        ]
        middleware_class, middleware_kwargs = create_rate_limiter_middleware(
            tier_overrides=tier_overrides,
        )
        app.add_middleware(middleware_class, **middleware_kwargs)

    # Error handler middleware
    middleware_class, middleware_kwargs = create_error_handler_middleware()
    app.add_middleware(middleware_class, **middleware_kwargs)

    # Request context lifecycle middleware
    middleware_class, middleware_kwargs = create_request_context_lifecycle_middleware()
    app.add_middleware(middleware_class, **middleware_kwargs)

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.security.allowed_origins,
        allow_credentials=settings.security.cors_allow_credentials,
        allow_methods=settings.security.cors_allow_methods,
        allow_headers=settings.security.cors_allow_headers,
    )

    # Security headers middleware (outermost to cover all responses)
    middleware_class, middleware_kwargs = create_security_headers_middleware(
        production=settings.environment == "production"
    )
    app.add_middleware(middleware_class, **middleware_kwargs)
    
    # ==========================================================================
    # API Routers
    # ==========================================================================
    
    # Include v1 API router
    app.include_router(api_v1_router)
    
    # Root endpoint (local-only for packaged security)
    @app.get("/")
    async def root(request: Request):
        """Root endpoint (local-only for security)."""
        require_local_request(request, settings)
        return JSONResponse({
            "status": "ok",
            "message": "Aether Backend API",
            "version": settings.app_version,
            "environment": settings.environment,
            "docs": "/docs"
        })
    
    # Root-level health endpoint for frontend compatibility (local-only for packaged security)
    @app.get("/health")
    async def health_check(request: Request):
        """
        Root-level health check endpoint (local-only for security).
        
        Frontend expects /health (not /v1/health) for quick connectivity checks.
        Returns basic status and uptime.
        """
        require_local_request(request, settings)
        return JSONResponse({
            "status": "ok",
            "timestamp": time.time(),
            "uptime_seconds": time.time() - START_TIME,
            "version": settings.app_version
        })

    # ==========================================================================
    # WebSocket Endpoint
    # ==========================================================================
    
    @app.websocket("/")
    async def websocket_endpoint(websocket: WebSocket):
        """
        Root WebSocket endpoint for real-time chat streaming.
        
        Handles:
        - Chat message streaming
        - Audio input/output streaming
        - Heartbeat/ping-pong
        - Client lifecycle management
        """
        try:
            require_local_request(websocket, settings)
        except HTTPException as e:
            await websocket.accept()
            await websocket.send_json({
                "role": "server",
                "type": "error",
                "content": e.detail,
                "error_details": {
                    "category": "security",
                    "technical_details": "Local-only endpoint access denied"
                }
            })
            await websocket.close(code=1008, reason="Policy Violation")
            return

        await websocket.accept()
        
        # Access WebSocket hub from app state (set during lifespan startup)
        ws_hub = getattr(app.state, "websocket_hub", None)
        
        if ws_hub is None:
            # Hub not initialized yet (runtime starting up)
            await websocket.send_json({
                "role": "server",
                "type": "error",
                "content": "Server is starting up. Please retry in a moment.",
                "error_details": {
                    "category": "connection",
                    "technical_details": "WebSocket hub not initialized"
                }
            })
            await websocket.close(code=1011, reason="Service unavailable")
            return
        
        client = await ws_hub.register(websocket)
        
        try:
            while True:
                try:
                    message = await websocket.receive()
                    # DEBUG: Log what we received
                    logger.debug(f"WS received from {client.id}: type={message.get('type')}, has_text={bool(message.get('text'))}, has_bytes={bool(message.get('bytes'))}")
                except RuntimeError as e:
                    if "disconnect" in str(e).lower():
                        logger.debug(f"Client {client.id} disconnected")
                        break
                    raise
                
                if message.get("type") == "websocket.disconnect":
                    logger.debug(f"Client {client.id} sent disconnect")
                    break
                
                if message.get("type") == "websocket.receive" and message.get("bytes"):
                    await ws_hub.handle_binary(client, message["bytes"])
                    continue
                
                data = message.get("text")
                if data:
                    logger.debug(f"Forwarding text message to hub: {len(data)} bytes")
                    await ws_hub.handle_json(client, data)
                else:
                    logger.warning(f"Received message without text data: {message}")
                    
        except WebSocketDisconnect:
            logger.info(f"WebSocket client {client.id} disconnected normally")
        except (ConnectionError, TimeoutError, ValueError, KeyError, OSError) as e:
            logger.error(f"WebSocket error for client {client.id}: {e}", exc_info=True)
            try:
                await websocket.send_json({
                    "role": "server",
                    "type": "system.error",
                    "data": {"message": "An internal error occurred."}
                })
            except (ConnectionError, OSError):
                pass
        finally:
            await ws_hub.unregister(client)
    
    return app
