import asyncio
from typing import Dict, Any, Optional
from application.setup.setup_service import SetupService
from monitoring import get_logger

logger = get_logger(__name__)

class SetupOrchestrator:
    """
    State machine orchestrator for backend setup phases.
    Handles phase transitions and background task execution.
    """
    def __init__(self, setup_service: SetupService):
        self.setup_service = setup_service
        self._current_phase = "idle" # idle | checking | installing | verifying | completed
        self._status = "idle" # idle | action_required | in_progress | completed | error
        self._error_msg: Optional[str] = None
        self._task: Optional[asyncio.Task] = None
        self._requirements: Optional[Dict[str, Any]] = None
        self._lock = asyncio.Lock()

    def get_state(self) -> Dict[str, Any]:
        """Returns the current state of the orchestrator."""
        return {
            "phase": self._current_phase,
            "status": self._status,
            "error": self._error_msg,
            "requirements": self._requirements,
            "progress": self.setup_service.get_setup_status()
        }

    async def handle_command(self, command: str) -> None:
        """Handle incoming commands to advance or retry the state machine."""
        async with self._lock:
            if command == "start_check":
                if self._current_phase not in ["checking", "installing", "verifying", "completed"]:
                    self._start_checking()
            elif command == "retry_check":
                if self._current_phase == "checking" and self._status == "action_required":
                    self._start_checking()
            elif command == "retry_install":
                if self._current_phase in ["installing", "checking"] and self._status == "error":
                    self._start_installing()
            elif command == "retry_verify":
                if self._current_phase == "verifying" and self._status == "error":
                    self._start_verifying()
            else:
                logger.warning(f"[SetupOrchestrator] Invalid command {command} for phase {self._current_phase} and status {self._status}")

    def _start_checking(self) -> None:
        self._current_phase = "checking"
        self._status = "in_progress"
        self._error_msg = None
        logger.info("[SetupOrchestrator] Entering Phase 1: Checking")
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._run_checking_phase())

    async def _run_checking_phase(self) -> None:
        try:
            # Check requirements in a separate thread to prevent event loop blocking
            self._requirements = await asyncio.to_thread(self.setup_service.check_setup_requirements)
            
            python_ok = self._requirements.get("python3", {}).get("installed", False)
            docker_ok = self._requirements.get("docker_daemon", {}).get("installed", False) and \
                        self._requirements.get("docker_daemon", {}).get("running", False)

            if python_ok and docker_ok:
                logger.info("[SetupOrchestrator] Phase 1: Checking passed. Transitioning to Installing.")
                self._start_installing()
            else:
                logger.warning("[SetupOrchestrator] Phase 1: Checking failed (action required).")
                self._status = "action_required"
        except Exception as e:
            logger.error("[SetupOrchestrator] Phase 1 Error: %s", e, exc_info=True)
            self._status = "error"
            self._error_msg = str(e)

    def _start_installing(self) -> None:
        self._current_phase = "installing"
        self._status = "in_progress"
        self._error_msg = None
        logger.info("[SetupOrchestrator] Entering Phase 2: Installing")
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._run_installing_phase())

    async def _run_installing_phase(self) -> None:
        try:
            try:
                await asyncio.to_thread(self.setup_service.trigger_setup)
            except ValueError:
                # Already in progress
                pass

            # Monitor progress
            while True:
                await asyncio.sleep(1)
                status = await asyncio.to_thread(self.setup_service.get_setup_status)
                
                phase = status.get("current_phase", "idle")
                
                if phase == "completed":
                    logger.info("[SetupOrchestrator] Phase 2: Installing completed. Transitioning to Verifying.")
                    self._start_verifying()
                    break
                elif phase == "error":
                    logger.error("[SetupOrchestrator] Phase 2: Installing error encountered.")
                    self._status = "error"
                    self._error_msg = status.get("error", "Setup installation failed")
                    break

        except Exception as e:
            logger.error("[SetupOrchestrator] Phase 2 Error: %s", e, exc_info=True)
            self._status = "error"
            self._error_msg = str(e)

    def _start_verifying(self) -> None:
        self._current_phase = "verifying"
        self._status = "in_progress"
        self._error_msg = None
        logger.info("[SetupOrchestrator] Entering Phase 3: Verifying")
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(self._run_verifying_phase())

    async def _run_verifying_phase(self) -> None:
        try:
            from api.dependencies import get_database_connection
            is_initialized = get_database_connection() is not None
            
            result = await self.setup_service.execute_setup(database_initialized=is_initialized)
            
            if not is_initialized:
                if result.get("status") in ["ok", "degraded"]:
                    from core.system.connection_manager import ConnectionManager
                    gateway = result.pop("gateway", None)
                    file_repo = result.pop("file_repo", None)
                    if gateway and file_repo:
                        ConnectionManager.get_instance().set_database_gateway(gateway)
                        ConnectionManager.get_instance().set_file_indexing_repository(file_repo)
            
            if result.get("status") in ["ok", "degraded"]:
                logger.info("[SetupOrchestrator] Phase 3: Verifying completed.")
                self._current_phase = "completed"
                self._status = "completed"
            else:
                self._status = "error"
                self._error_msg = "\n".join(result.get("errors", ["Service connection failed."]))

        except Exception as e:
            logger.error("[SetupOrchestrator] Phase 3 Error: %s", e, exc_info=True)
            self._status = "error"
            self._error_msg = str(e)
