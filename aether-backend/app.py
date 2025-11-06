"""
FastAPI Application Factory

Creates and configures the FastAPI application with:
- API versioning
- Middleware (CORS, security, monitoring, error handling)
- Dependency injection setup
- Lifecycle management (startup/shutdown)

@.architecture
Incoming: main.py, config/settings.py, api/v1/router.py, ws/hub.py, api/middleware/*.py --- {Settings object, APIRouter instances, middleware constructors}
Processing: create_app(), startup_event(), shutdown_event(), websocket_endpoint() --- {11 jobs: application_creation, cleanup, connection_management, dependency_injection, health_monitoring, initialization, lifecycle_management, message_routing, middleware_registration, routing_registration, tool_catalog_generation}
Outgoing: main.py, Frontend (HTTP/WebSocket) --- {FastAPI application instance, HTTP responses, WebSocket messages}
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import asyncio
import time

from config.settings import get_settings
from api.v1.router import api_v1_router
from ws import WebSocketHub
from api.middleware import (
    create_security_headers_middleware,
    create_rate_limiter_middleware,
    create_error_handler_middleware
)
from api.dependencies import (
    set_runtime_engine,
    set_mcp_manager,
    set_database_connection
)
from monitoring import (
    configure_from_preset,
    get_logger,
    initialize_health_checks,
    get_tracer
)

logger = get_logger(__name__)

# Track startup time for uptime calculation
START_TIME = time.time()


def create_app() -> FastAPI:
    """
    Create and configure FastAPI application.
    
    Returns:
        FastAPI: Configured application instance
    """
    # Load settings
    settings = get_settings()
    
    # Configure logging based on environment
    if settings.environment == "production":
        configure_from_preset("production")
    elif settings.environment == "test":
        configure_from_preset("testing")
    else:
        configure_from_preset("development")
    
    logger.info(f"Creating Aether Backend application (environment: {settings.environment})")
    
    # Create FastAPI app
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="Aether AI Backend - Production Ready API",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        redirect_slashes=False  # Disable automatic trailing slash redirect
    )
    
    # ==========================================================================
    # Middleware Configuration
    # ==========================================================================
    
    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.security.allowed_origins,
        allow_credentials=settings.security.cors_allow_credentials,
        allow_methods=settings.security.cors_allow_methods,
        allow_headers=settings.security.cors_allow_headers,
    )
    
    # Security headers middleware
    middleware_class, middleware_kwargs = create_security_headers_middleware()
    app.add_middleware(middleware_class, **middleware_kwargs)
    
    # Rate limiter middleware (if enabled)
    if settings.security.rate_limit_enabled:
        middleware_class, middleware_kwargs = create_rate_limiter_middleware()
        app.add_middleware(middleware_class, **middleware_kwargs)
    
    # Error handler middleware
    middleware_class, middleware_kwargs = create_error_handler_middleware()
    app.add_middleware(middleware_class, **middleware_kwargs)
    
    # ==========================================================================
    # API Routers
    # ==========================================================================
    
    # Include v1 API router
    app.include_router(api_v1_router)
    
    # Root endpoint
    @app.get("/")
    async def root():
        """Root endpoint."""
        return JSONResponse({
            "status": "ok",
            "message": "Aether Backend API",
            "version": settings.app_version,
            "environment": settings.environment,
            "docs": "/docs"
        })
    
    # Root-level health endpoint for frontend compatibility
    @app.get("/health")
    async def health_check():
        """
        Root-level health check endpoint.
        
        Frontend expects /health (not /v1/health) for quick connectivity checks.
        Returns basic status and uptime.
        """
        return JSONResponse({
            "status": "ok",
            "timestamp": time.time(),
            "uptime_seconds": time.time() - START_TIME,
            "version": settings.app_version
        })
    
    # ==========================================================================
    # WebSocket Endpoint
    # ==========================================================================
    
    # WebSocket hub (initialized after runtime startup)
    ws_hub = None
    
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
        await websocket.accept()
        
        if ws_hub is None:
            # Hub not initialized yet (runtime starting up)
            await websocket.send_json({
                "type": "system.error",
                "data": {"message": "Server is starting up. Please retry in a moment."}
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
        except Exception as e:
            logger.error(f"WebSocket error for client {client.id}: {e}", exc_info=True)
            try:
                await websocket.send_json({
                    "type": "system.error",
                    "data": {"message": str(e)}
                })
            except Exception:
                pass
        finally:
            await ws_hub.unregister(client)
    
    # ==========================================================================
    # Lifecycle Events
    # ==========================================================================
    
    @app.on_event("startup")
    async def startup_event():
        """
        Application startup.
        
        Initializes:
        - Runtime engine
        - WebSocket hub
        - MCP manager
        - Database connections
        - Backend API tool registration with OI
        - Health checks
        - Monitoring
        """
        nonlocal ws_hub
        
        logger.info("=== Application Startup ===")
        
        try:
            # Initialize runtime engine
            logger.info("Initializing runtime engine...")
            from core.runtime.engine import RuntimeEngine
            runtime = RuntimeEngine(settings=settings)
            await runtime.start()
            set_runtime_engine(runtime)
            logger.info("✅ Runtime engine initialized")
            
            # Initialize WebSocket hub
            logger.info("Initializing WebSocket hub...")
            ws_hub = WebSocketHub(runtime)
            logger.info("✅ WebSocket hub initialized")
            
        except Exception as e:
            logger.error(f"Failed to initialize runtime engine: {e}", exc_info=True)
            # Continue without runtime - endpoints will return 503
        
        try:
            # Initialize MCP manager (if enabled)
            if settings.integrations.mcp_enabled:
                logger.info("Initializing MCP manager...")
                from core.mcp.manager import MCPServerManager
                from core.mcp.database import MCPDatabase
                
                mcp_db = MCPDatabase(settings.database.url)
                await mcp_db.initialize()
                
                mcp_manager = MCPServerManager(mcp_db)
                await mcp_manager.start()
                set_mcp_manager(mcp_manager)
                logger.info("✅ MCP manager initialized")
            else:
                logger.info("MCP disabled in settings")
                
        except Exception as e:
            logger.error(f"Failed to initialize MCP manager: {e}", exc_info=True)
            # Continue without MCP - endpoints will return 503
        
        try:
            # Initialize database connection
            logger.info("Initializing database...")
            from data.database.connection import DatabaseConnection
            db = DatabaseConnection(settings.database.url)
            await db.connect()
            set_database_connection(db)
            logger.info("✅ Database initialized")
            
        except Exception as e:
            logger.error(f"Failed to initialize database: {e}", exc_info=True)
            # Continue without database - storage endpoints will not work
        
        try:
            # Initialize health checks and register components
            logger.info("Initializing health checks...")
            
            # Register runtime engine if available
            try:
                from api.dependencies import get_runtime_engine
                from monitoring import get_health_checker
                
                runtime = get_runtime_engine()
                health_checker = get_health_checker()
                
                if runtime and health_checker:
                    health_checker.register_checker("runtime", runtime)
                    logger.debug("✅ Runtime registered with health checker")
            except Exception as e:
                logger.debug(f"Runtime health registration skipped: {e}")
            
            # Register database if available  
            try:
                from api.dependencies import get_database
                from monitoring import get_health_checker
                
                db = get_database()
                health_checker = get_health_checker()
                
                if db and health_checker:
                    health_checker.register_checker("database", db)
                    logger.debug("✅ Database registered with health checker")
            except Exception as e:
                logger.debug(f"Database health registration skipped: {e}")
            
            logger.info("✅ Health checks initialized")
            
        except Exception as e:
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
                logger.info("✅ backend_tools_registry.yaml generated successfully")
                logger.info(f"   Location: {settings.config_dir / 'backend_tools_registry.yaml'}")
                logger.info("   OI will load this on next initialization")
            else:
                logger.warning("⚠️  Failed to generate backend_tools_registry.yaml")
                
        except Exception as e:
            logger.warning(f"Backend tools YAML generation failed (non-critical): {e}", exc_info=True)
        
        logger.info("=== Startup Complete ===")
    
    @app.on_event("shutdown")
    async def shutdown_event():
        """
        Application shutdown.
        
        Cleanup:
        - Stop runtime engine
        - Stop MCP manager
        - Close database connections
        """
        logger.info("=== Application Shutdown ===")
        
        try:
            # Stop runtime engine
            from api.dependencies import get_runtime_engine
            runtime = get_runtime_engine()
            if runtime:
                await runtime.stop()
                logger.info("✅ Runtime engine stopped")
        except Exception as e:
            logger.error(f"Error stopping runtime: {e}")
        
        try:
            # Stop MCP manager
            from api.dependencies import get_mcp_manager
            mcp_manager = get_mcp_manager()
            if mcp_manager:
                await mcp_manager.stop()
                logger.info("✅ MCP manager stopped")
        except Exception as e:
            logger.error(f"Error stopping MCP manager: {e}")
        
        try:
            # Close database using dependency getter for consistency
            from api.dependencies import get_database
            try:
                async for db in get_database():
                    if db:
                        await db.disconnect()
                        logger.info("✅ Database closed")
            except HTTPException:
                # Database not initialized, nothing to close
                pass
        except Exception as e:
            logger.error(f"Error closing database: {e}")
        
        logger.info("=== Shutdown Complete ===")
    
    return app

