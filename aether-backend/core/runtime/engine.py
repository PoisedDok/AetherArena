"""
Runtime Engine - Main orchestrator for Aether backend runtime

@.architecture
Incoming: app.py (startup_event), api/dependencies.py, ws/handlers.py --- {Settings object, stream_chat requests from WebSocket/HTTP, file processing requests}
Processing: start(), stop(), _initialize_all_modules(), _cleanup_all_modules(), stream_chat(), stop_generation(), handle_file_chat(), _load_integrations(), _validate_integrations(), get_health_status() --- {10 jobs: cancellation, cleanup, dependency_injection, health_monitoring, initialization, integration_loading, lifecycle_management, module_coordination, streaming_orchestration, validation}
Outgoing: core/runtime/streaming.py, core/runtime/interpreter.py, core/runtime/document.py, ws/handlers.py, api/v1/endpoints/chat.py --- {AsyncGenerator[Dict] streaming chunks, interpreter instances, processing results}

Handles:
- Module initialization and dependency injection
- Lifecycle management (start/stop)
- Integration loading and validation
- MCP bridge installation
- Request coordination across modules
- Health monitoring and diagnostics
- Resource cleanup

Production Features:
- Proper dependency injection
- Initialization order management
- Complete error handling
- Graceful shutdown
- Health diagnostics
- MCP integration
- Integration validation

This is the entry point for the entire runtime system.
"""

import asyncio
import logging
from typing import Any, AsyncGenerator, Dict, Optional

logger = logging.getLogger(__name__)


class RuntimeEngine:
    """
    Main runtime engine that orchestrates all modules and provides unified API.
    
    This engine consolidates the functionality of both OIBackendRuntime and
    RuntimeModuleFactory into a single, production-ready orchestrator.
    
    Features:
    - Module initialization with proper dependency injection
    - Lifecycle management (start/stop/cleanup)
    - Settings management and application
    - Interpreter setup and configuration
    - Integration loading and validation
    - MCP bridge installation
    - Request tracking and cancellation
    - File processing and document analysis
    - Chat streaming coordination
    - Health monitoring and diagnostics
    
    Architecture:
    - ConfigManager: Configuration and HTTP client
    - RequestTracker: Request lifecycle management
    - InterpreterManager: Open Interpreter lifecycle
    - DocumentProcessor: File processing
    - ChatStreamer: Chat streaming
    """

    def __init__(self, settings: Any):
        """
        Initialize runtime engine with settings.
        
        Args:
            settings: RuntimeSettings object from settings schema
        """
        self.settings = settings
        
        # Module instances (dependency injection container)
        self._config_manager: Optional[Any] = None
        self._request_tracker: Optional[Any] = None
        self._interpreter_manager: Optional[Any] = None
        self._document_processor: Optional[Any] = None
        self._chat_streamer: Optional[Any] = None
        
        # State tracking
        self._initialized = False
        self._startup_complete = False
        
        # Legacy compatibility
        self._audio_sessions: Dict[str, bool] = {}

    # ============================================================================
    # LIFECYCLE MANAGEMENT
    # ============================================================================

    async def start(self, mcp_manager=None) -> None:
        """
        Initialize runtime with all modules and integrations.
        
        Args:
            mcp_manager: Optional MCP server manager for bridge installation
        """
        try:
            logger.info("[Runtime] Initializing production runtime engine...")
            
            # Initialize all modules in dependency order
            success = await self._initialize_all_modules()
            if not success:
                raise RuntimeError("Failed to initialize runtime modules")
            
            # Load and apply centralized settings
            self.settings = self._config_manager.load_and_apply_settings(self.settings)
            
            # Create and configure interpreter
            await self._setup_interpreter(mcp_manager)
            
            # Mark startup complete
            self._startup_complete = True
            logger.info("[Runtime] Runtime engine startup complete")
            
        except Exception as e:
            logger.error(f"[Runtime] Startup failed: {e}", exc_info=True)
            await self._cleanup_all_modules()
            raise

    async def _initialize_all_modules(self) -> bool:
        """
        Initialize all modules in dependency order.
        
        Returns:
            True if all modules initialized successfully
        """
        if self._initialized:
            return True
        
        try:
            logger.info("Initializing runtime modules...")
            
            # Initialize modules in dependency order
            await self._init_config_manager()
            await self._init_request_tracker()
            await self._init_interpreter_manager()
            await self._init_document_processor()
            await self._init_chat_streamer()
            
            self._initialized = True
            logger.info("✅ All runtime modules initialized successfully")
            return True
            
        except Exception as e:
            logger.error(f"Failed to initialize runtime modules: {e}")
            await self._cleanup_all_modules()
            return False

    async def _init_config_manager(self) -> None:
        """Initialize configuration and HTTP client manager."""
        from .config import ConfigManager
        
        self._config_manager = ConfigManager()
        logger.debug("Config manager initialized")

    async def _init_request_tracker(self) -> None:
        """Initialize request tracker."""
        from .request import RequestTracker
        
        self._request_tracker = RequestTracker()
        logger.debug("Request tracker initialized")

    async def _init_interpreter_manager(self) -> None:
        """Initialize interpreter manager."""
        from .interpreter import InterpreterManager
        
        manager = InterpreterManager()
        success = await manager.initialize()
        if not success:
            raise RuntimeError("Failed to initialize interpreter manager")
        
        self._interpreter_manager = manager
        logger.debug("Interpreter manager initialized")

    async def _init_document_processor(self) -> None:
        """Initialize document processor."""
        from .document import DocumentProcessor
        
        if not self._config_manager or not self._request_tracker:
            raise RuntimeError(
                "Config manager and request tracker required for document processor"
            )
        
        self._document_processor = DocumentProcessor(
            self._config_manager, self._request_tracker
        )
        logger.debug("Document processor initialized")

    async def _init_chat_streamer(self) -> None:
        """Initialize chat streamer."""
        from .streaming import ChatStreamer
        
        if not self._config_manager or not self._request_tracker:
            raise RuntimeError(
                "Config manager and request tracker required for chat streamer"
            )
        
        self._chat_streamer = ChatStreamer(
            self._config_manager, self._request_tracker
        )
        logger.debug("Chat streamer initialized")

    async def _setup_interpreter(self, mcp_manager) -> None:
        """Setup Open Interpreter with all integrations."""
        # Create interpreter instance
        interpreter = await self._interpreter_manager.create_interpreter()
        if not interpreter:
            raise RuntimeError("Failed to create interpreter instance")
        
        # Apply settings
        self._interpreter_manager.apply_settings(self.settings, init=True)
        
        # Add web search capability
        self._interpreter_manager.add_web_search_capability()
        
        # Load integrations through unified loader
        await self._load_integrations(interpreter)
        
        # Install MCP bridge if manager provided
        if mcp_manager:
            await self._setup_mcp_bridge(interpreter, mcp_manager)

    async def _load_integrations(self, interpreter) -> None:
        """Load all integrations using the unified loader."""
        try:
            from ..integrations.framework import IntegrationLoader
            
            loader = IntegrationLoader(interpreter)
            results = loader.load_all()
            logger.info(f"✅ Integration loader: {loader.get_integration_summary()}")
            
            # Validate integrations
            await self._validate_integrations()
            
        except Exception as e:
            logger.error(f"Failed to load integrations: {e}", exc_info=True)
    

    async def _validate_integrations(self) -> None:
        """Run integration validation and health checks."""
        try:
            from ..integrations.framework import (
                IntegrationValidator,
                IntegrationHealthChecker,
            )
            
            logger.info("[Validation] Running integration compliance checks...")
            validator = IntegrationValidator()
            validation_reports = validator.validate_all()
            
            compliant_count = sum(
                1 for r in validation_reports.values() if r.overall_compliant
            )
            total_count = len(validation_reports)
            
            if compliant_count < total_count:
                logger.warning(
                    f"[Validation] {compliant_count}/{total_count} integrations compliant"
                )
            else:
                logger.info(
                    f"[Validation] ✅ All {total_count} integrations compliant"
                )
            
            logger.info("[Health Check] Running integration health checks...")
            health_checker = IntegrationHealthChecker()
            health_reports = health_checker.check_all()
            
            healthy_count = sum(1 for r in health_reports.values() if r.passed)
            checked_count = len(health_reports)
            
            if healthy_count < checked_count:
                logger.warning(
                    f"[Health Check] {healthy_count}/{checked_count} integrations healthy"
                )
            else:
                logger.info(
                    f"[Health Check] ✅ All {checked_count} integrations healthy"
                )
                
        except Exception as e:
            logger.warning(f"Integration validation failed (non-critical): {e}")

    async def _setup_mcp_bridge(self, interpreter, mcp_manager) -> None:
        """Setup MCP bridge for external server integration."""
        try:
            from ..integrations.providers.mcp.bridge import MCPBridge
            
            bridge = MCPBridge(interpreter, mcp_manager)
            
            if bridge.install():
                logger.info("[Runtime] MCP bridge installation complete")
                
                # Register dynamic tools after brief delay
                await asyncio.sleep(0.5)
                await bridge._register_dynamic_tools_async()
            else:
                logger.warning("[Runtime] MCP bridge installation failed")
                
        except Exception as e:
            logger.error(f"[Runtime] Failed to setup MCP bridge: {e}", exc_info=True)

    async def stop(self) -> None:
        """Shutdown runtime and cleanup all resources."""
        logger.info("[Runtime] Shutting down runtime engine...")
        
        # Cleanup all modules
        await self._cleanup_all_modules()
        
        self._startup_complete = False
        logger.info("[Runtime] Runtime engine shutdown complete")

    async def _cleanup_all_modules(self) -> None:
        """Cleanup all modules in reverse initialization order."""
        logger.info("Cleaning up runtime modules...")
        
        # Cleanup in reverse order to handle dependencies
        cleanup_tasks = [
            ("chat_streamer", self._chat_streamer),
            ("document_processor", self._document_processor),
            ("interpreter_manager", self._interpreter_manager),
            ("request_tracker", self._request_tracker),
            ("config_manager", self._config_manager),
        ]
        
        for module_name, module in cleanup_tasks:
            if module and hasattr(module, "cleanup"):
                try:
                    await module.cleanup()
                    logger.debug(f"Cleaned up {module_name}")
                except Exception as e:
                    logger.warning(f"Error cleaning up {module_name}: {e}")
        
        # Clear references
        self._chat_streamer = None
        self._document_processor = None
        self._interpreter_manager = None
        self._request_tracker = None
        self._config_manager = None
        
        self._initialized = False
        logger.info("✅ Runtime modules cleanup complete")

    # ============================================================================
    # REQUEST MANAGEMENT
    # ============================================================================

    async def stop_generation(self, request_id: str) -> None:
        """
        Stop/interrupt an ongoing generation by request ID.
        
        Args:
            request_id: Unique request identifier to stop
        """
        logger.info(f"Stop request received for request {request_id}")
        
        # Use request tracker for centralized cancellation
        cancelled = await self._request_tracker.cancel_request(request_id)
        
        if not cancelled:
            logger.debug(f"Request {request_id} not found in active requests")
            return
        
        # Stop interpreter if available
        if self._interpreter_manager.is_available():
            await self._stop_interpreter_generation(request_id)
        
        # Reset HTTP client for fallback cancellation
        await self._config_manager.reset_client()

    async def _stop_interpreter_generation(self, request_id: str) -> None:
        """Stop interpreter generation using multiple methods."""
        interpreter = self._interpreter_manager.get_interpreter()
        if not interpreter:
            return
        
        try:
            # Method 1: Set the stop_event (primary method for AsyncInterpreter)
            if hasattr(interpreter, "stop_event"):
                interpreter.stop_event.set()
                logger.debug(f"Set stop_event for request {request_id}")
                
                # Wait briefly then clear for next use
                await asyncio.sleep(0.1)
                interpreter.stop_event.clear()
            
            # Method 2: Send an interrupt signal via input method
            try:
                if hasattr(interpreter, "input"):
                    await interpreter.input({"type": "interrupt", "id": request_id})
                    logger.debug(f"Sent interrupt input for request {request_id}")
            except Exception as e:
                logger.debug(f"Failed to send interrupt input: {e}")
            
            # Method 3: Force abort ongoing LLM calls
            try:
                if hasattr(interpreter, "llm") and hasattr(interpreter.llm, "client"):
                    if hasattr(interpreter.llm.client, "abort_generate"):
                        interpreter.llm.client.abort_generate()
                        logger.debug(f"Aborted LLM generation for request {request_id}")
            except Exception as e:
                logger.debug(f"Failed to abort LLM client: {e}")
                
        except Exception as e:
            logger.debug(f"Failed to stop interpreter: {e}")

    # ============================================================================
    # FILE PROCESSING
    # ============================================================================

    async def handle_file_chat(
        self,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Process a file with document analysis.
        
        Args:
            file_data: Dict with file metadata (name, base64, category, etc.)
            prompt: Optional user prompt for analysis
            request_id: Optional request ID for tracking
            
        Returns:
            Dict with processing status and results
        """
        interpreter = self._interpreter_manager.get_interpreter()
        
        return await self._document_processor.process_file_chat(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    async def handle_file_chat_multipart(
        self,
        file_data: Dict[str, Any],
        prompt: str = "",
        request_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Process a multipart file upload with document analysis.
        
        Args:
            file_data: Dict with file data including UploadFile object
            prompt: User prompt for analysis
            request_id: Optional request identifier
            
        Returns:
            Dict with processing status and results
        """
        interpreter = self._interpreter_manager.get_interpreter()
        
        return await self._document_processor.process_file_chat_multipart(
            file_data=file_data,
            prompt=prompt,
            request_id=request_id,
            interpreter=interpreter,
        )

    # ============================================================================
    # AUDIO PROCESSING (STUB)
    # ============================================================================

    async def start_audio_stream(self, client_id: str) -> None:
        """Start audio streaming session (stub implementation)."""
        self._audio_sessions[client_id] = True

    async def end_audio_stream(self, client_id: str) -> None:
        """End audio streaming session (stub implementation)."""
        self._audio_sessions.pop(client_id, None)

    async def handle_audio_chunk(self, client_id: str, chunk: bytes) -> None:
        """Handle audio chunk (stub - TODO: DSM STT streaming integration)."""
        # TODO: DSM STT streaming integration; emit stt-partial/final via hub
        return None

    # ============================================================================
    # CHAT STREAMING
    # ============================================================================

    async def stream_chat(
        self,
        *,
        client_id: str,
        text: str,
        image_b64: Optional[str],
        request_id: str,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream chat completion.
        
        Args:
            client_id: Client identifier
            text: User message text
            image_b64: Optional base64 image data
            request_id: Unique request identifier
            
        Yields:
            Streaming response chunks
        """
        # Wait for startup to complete
        if not self._startup_complete:
            logger.warning("Waiting for runtime startup to complete...")
            # Wait up to 30 seconds for startup
            for _ in range(30):
                if self._startup_complete:
                    break
                await asyncio.sleep(1)
            else:
                logger.error("Startup did not complete in time!")
                return
        
        # Delegate to chat streamer
        interpreter = self._interpreter_manager.get_interpreter()
        
        async for chunk in self._chat_streamer.stream_chat(
            client_id=client_id,
            text=text,
            image_b64=image_b64,
            request_id=request_id,
            interpreter=interpreter,
            settings=self.settings,
        ):
            yield chunk

    # ============================================================================
    # HEALTH AND STATUS
    # ============================================================================

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get comprehensive health status of the runtime and all modules.
        
        Returns:
            Dict with health status information
        """
        status = {
            "runtime": {
                "initialized": self._initialized,
                "startup_complete": self._startup_complete,
                "module_count": self._get_module_count(),
            },
            "modules": self._get_module_health_status(),
            "active_requests": (
                self._request_tracker.get_request_count()
                if self._request_tracker
                else 0
            ),
            "active_audio_sessions": len(self._audio_sessions),
        }
        
        return status

    def _get_module_count(self) -> int:
        """Get count of initialized modules."""
        return sum(
            1
            for module in [
                self._config_manager,
                self._request_tracker,
                self._interpreter_manager,
                self._document_processor,
                self._chat_streamer,
            ]
            if module is not None
        )

    def _get_module_health_status(self) -> Dict[str, Any]:
        """Get health status of all modules."""
        status = {}
        
        modules = {
            "config_manager": self._config_manager,
            "request_tracker": self._request_tracker,
            "interpreter_manager": self._interpreter_manager,
            "document_processor": self._document_processor,
            "chat_streamer": self._chat_streamer,
        }
        
        for name, module in modules.items():
            if module and hasattr(module, "get_health_status"):
                try:
                    status[name] = module.get_health_status()
                except Exception as e:
                    logger.debug(f"Health check failed for {name}: {e}")
                    status[name] = {"error": str(e)}
            else:
                status[name] = {"available": module is not None}
        
        return status

    def is_ready(self) -> bool:
        """
        Check if runtime is fully ready for operations.
        
        Returns:
            True if runtime is initialized and all modules are healthy
        """
        if not self._startup_complete:
            return False
        
        # Check that all critical modules are initialized
        critical_modules = [
            self._config_manager,
            self._request_tracker,
            self._interpreter_manager,
            self._document_processor,
            self._chat_streamer,
        ]
        
        return all(module is not None for module in critical_modules)

    async def cleanup_stale_resources(self) -> int:
        """
        Cleanup stale resources across all modules.
        
        Returns:
            Number of resources cleaned up
        """
        cleaned = 0
        
        # Cleanup stale requests
        if self._request_tracker:
            cleaned += await self._request_tracker.cleanup_stale_requests()
        
        return cleaned
    
    async def get_history(self, session_id: str) -> list:
        """
        Retrieve conversation history for a session.
        
        Args:
            session_id: Session identifier
            
        Returns:
            List of conversation messages
            
        Note: Currently returns in-memory history from chat streamer.
        For persistent storage, use database repositories.
        """
        if not self._chat_streamer:
            return []
        
        # Return a copy to prevent external modification
        return list(self._chat_streamer._conversation_history)

