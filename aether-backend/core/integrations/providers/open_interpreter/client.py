"""
Open Interpreter Client
Wraps the raw vendor library imports, path management, and instance creation.
Acts as the bridge between Aether and an externally-provided Open Interpreter runtime.

@.architecture
Incoming: core/runtime/interpreter.py --- {None}
Processing: import vendor modules, configure sys.path, instantiate AsyncInterpreter --- {JOB_INITIALIZE_COMPONENT, JOB_LOAD_CONFIG}
Outgoing: core/runtime/interpreter.py --- {AsyncInterpreter instance}
"""

import logging
import os
import sys
from pathlib import Path
from typing import Any, List, Optional, Type

# Configure logger
logger = logging.getLogger(__name__)


class OpenInterpreterClient:
    """
    Low-level client for interacting with the Open Interpreter library.
    Handles the complexity of dynamically importing the checked-in vendor code.
    """

    def __init__(self):
        """Initialize the client state."""
        self._AsyncInterpreter: Optional[Type] = None
        self._apply_profile_func: Optional[Any] = None
        self._initialized = False
        self._oi_path: Optional[Path] = None

    @property
    def is_initialized(self) -> bool:
        """Check if the client has successfully imported OI components."""
        return self._initialized

    async def initialize(self) -> None:
        """
        Import and validate Open Interpreter components.
        Modifies sys.path to include the checked-in vendor code.
        """
        if self._initialized:
            return

        # Check if we are in external server mode via env var before even trying imports
        is_external = os.getenv("INTERPRETER_EXTERNAL_SERVER_ENABLED", "").lower() in ("1", "true", "yes")

        try:
            # locate and register package path
            self._register_package_path()

            # Import AsyncInterpreter
            logger.debug("Attempting to import AsyncInterpreter...")
            try:
                from interpreter import AsyncInterpreter  # type: ignore
                logger.debug("AsyncInterpreter imported successfully")

                # Import profiles
                logger.debug("Attempting to import profiles...")
                from interpreter.terminal_interface.profiles.profiles import (  # type: ignore
                    profile as oi_apply_profile,
                )
                logger.debug("Profiles imported successfully")

                self._AsyncInterpreter = AsyncInterpreter
                self._apply_profile_func = oi_apply_profile
                self._initialized = True
                logger.info("Open Interpreter components initialized successfully (Local Mode)")
            except ImportError:
                if is_external:
                    logger.info("Open Interpreter package not found, but external server mode is enabled. Proceeding in Proxy Mode.")
                    self._initialized = True # Mark as initialized for proxy use
                else:
                    logger.warning("Open Interpreter package not found and external server mode is NOT enabled. Local execution will fail.")
                    raise

        except Exception as e:
            if is_external:
                logger.info("Open Interpreter local initialization failed (%s), but external server mode is enabled. Proceeding in Proxy Mode.", e)
                self._initialized = True
            else:
                logger.error("Failed to initialize Open Interpreter client: %s", e, exc_info=True)
                raise RuntimeError(f"Open Interpreter initialization failed: {e}") from e

    def create_interpreter(self) -> Any:
        """
        Create a new AsyncInterpreter instance.
        
        Returns:
            New interpreter instance
            
        Raises:
            RuntimeError: If client is not initialized
        """
        if not self._initialized or not self._AsyncInterpreter:
            raise RuntimeError("Open Interpreter not initialized. Call initialize() first.")
        
        return self._AsyncInterpreter()

    def apply_profile(self, interpreter: Any, profile_name: str) -> None:
        """
        Apply a named profile to an interpreter instance.
        
        Args:
            interpreter: The interpreter instance
            profile_name: Name of the profile to apply
        """
        if not self._apply_profile_func:
            logger.warning("Profile application function not available")
            return

        try:
            self._apply_profile_func(interpreter, profile_name)
        except Exception as e:
            logger.error("Failed to apply profile '%s': %s", profile_name, e)
            raise

    def _register_package_path(self) -> None:
        """
        Register Open Interpreter import path ONLY when explicitly allowed.

        Legal-clean rule: no implicit sys.path injection and no legacy path hunting.

        Allowed modes:
        - Default: do NOT modify sys.path (system site-packages import only).
        - Explicit vendored mode: requires BOTH:
          - INTERPRETER_ALLOW_VENDORED_RUNTIME=1
          - INTERPRETER_VENDOR_PATH=/absolute/path/to/open-interpreter (directory containing `interpreter/`)
        """
        allow_vendored = os.getenv("INTERPRETER_ALLOW_VENDORED_RUNTIME", "").lower() in ("1", "true", "yes")
        vendor_path = os.getenv("INTERPRETER_VENDOR_PATH", "").strip()

        if not allow_vendored:
            # No sys.path injection; system install only.
            return

        if not vendor_path:
            raise RuntimeError(
                "INTERPRETER_ALLOW_VENDORED_RUNTIME is enabled but INTERPRETER_VENDOR_PATH is empty. "
                "Refusing to guess candidate paths."
            )

        oi_path = Path(vendor_path).expanduser().resolve()
        if not oi_path.exists():
            raise RuntimeError(f"INTERPRETER_VENDOR_PATH does not exist: {oi_path}")

        # Insert at beginning of path to prioritize the explicitly provided path.
        if str(oi_path) not in sys.path:
            sys.path.insert(0, str(oi_path))
            logger.debug("Added %s to sys.path (explicit vendored runtime)", oi_path)

        # OPEN_INTERPRETER_PATH is used by OI internals for computer API import.
        os.environ["OPEN_INTERPRETER_PATH"] = str(oi_path)
        self._oi_path = oi_path
        logger.info("Open Interpreter vendored runtime enabled via explicit INTERPRETER_VENDOR_PATH")

    def _get_path_candidates(self) -> List[Path]:
        """
        Legacy method retained for backwards compatibility.

        Legal-clean rule: we do not auto-discover Open Interpreter paths anymore.
        """
        return []

