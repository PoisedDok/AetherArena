"""
Setup and Onboarding Endpoints

Comprehensive E2E onboarding: clones repos, installs packages, downloads models, pulls Docker services.
Provides granular progress tracking for premium frontend UX.

@.architecture
Incoming: Frontend Onboarding (HTTP POST) --- {Task triggers}
Processing: core/system/setup_engine.py --- {Engine for git, pip, models, docker}
Outgoing: Frontend (HTTP GET) --- {SetupStatus from logs/setup_progress.json}
"""

from typing import Dict, Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from api.dependencies import get_setup_service, get_setup_orchestrator
from application.setup.setup_service import SetupService
from application.setup.setup_orchestrator import SetupOrchestrator
from monitoring import get_logger

logger = get_logger(__name__)
router = APIRouter(tags=["setup"])


class SetupStatus(BaseModel):
    repositories: Dict[str, Any]
    python_packages: Dict[str, Any]
    oi_environment: Dict[str, Any]
    inference_environment: Dict[str, Any]
    ml_models: Dict[str, Any]
    docker_services: Dict[str, Any]
    total_progress: int
    current_phase: str
    error: Optional[str] = None

@router.get("/setup/status", response_model=SetupStatus)
def get_setup_status(setup_service: SetupService = Depends(get_setup_service)):
    """Get current setup and download progress."""
    return SetupStatus(**setup_service.get_setup_status())

@router.get(
    "/setup/requirements",
    summary="Get setup pre-flight requirements",
    description="Returns a detailed check of all prerequisites needed before running setup.",
)
def get_setup_requirements(setup_service: SetupService = Depends(get_setup_service)):
    """Get detailed pre-flight requirements check."""
    return setup_service.check_setup_requirements()

@router.post(
    "/setup/start",
    summary="Start onboarding setup",
    description="Launches the comprehensive E2E setup script in the background. "
                "Tracks progress in a JSON file polled by the frontend.",
)
def trigger_setup(setup_service: SetupService = Depends(get_setup_service)):
    """Trigger the comprehensive E2E setup process."""
    try:
        setup_service.trigger_setup()
        return {"message": "Setup engine initiated"}
    except ValueError:
        return {"message": "Setup already in progress"}
    except Exception as e:
        logger.error("Failed to launch setup script: %s", e)
        raise HTTPException(status_code=500, detail="Failed to launch setup engine. Check server logs for details.")


@router.post(
    "/setup/skip",
    summary="Skip onboarding setup (disabled)",
    description=(
        "Legacy endpoint retained for compatibility. "
        "Hard-block onboarding policy disables setup skipping."
    ),
)
async def skip_setup():
    """Skipping setup is forbidden under hard-block onboarding policy."""
    logger.warning("Rejected setup skip request: hard-block onboarding policy enabled")
    raise HTTPException(
        status_code=403,
        detail="Setup skip is disabled. Complete onboarding setup to continue.",
    )

@router.post(
    "/setup/finalize",
    summary="Finalize setup: connect backend to Docker services",
    description="Called by the frontend after setup_engine.py completes and Docker services are healthy. "
                "Initializes database (Supabase), Redis, and runs migrations. "
                "Transitions the backend from degraded mode to fully operational.",
)
async def finalize_setup(setup_service: SetupService = Depends(get_setup_service)):
    """
    Connect the backend to the now-running Docker services.
    
    This endpoint is the bridge between onboarding (which starts Docker)
    and full backend operation (which requires database + Redis).
    It replicates the initialization logic from app.py::create_app but
    runs on-demand instead of at startup.
    """
    from api.dependencies import get_database_connection
    is_initialized = get_database_connection() is not None
    result = await setup_service.execute_setup(database_initialized=is_initialized)
    
    # If the gateway and repository were successfully created (even in degraded mode),
    # wire them up immediately so subsequent requests (like Step 4 Knowledge) can function.
    if not is_initialized:
        if result.get("status") == "ok":
            from core.system.connection_manager import ConnectionManager
            gateway = result.pop("gateway", None)
            file_repo = result.pop("file_repo", None)
            if gateway and file_repo:
                ConnectionManager.get_instance().set_database_gateway(gateway)
                ConnectionManager.get_instance().set_file_indexing_repository(file_repo)
            
    return result


@router.get(
    "/setup/onboarding-state",
    summary="Get onboarding UI state",
    description="Returns the current onboarding UI state.",
)
def get_onboarding_state(setup_service: SetupService = Depends(get_setup_service)):
    """Get onboarding UI state."""
    state = setup_service.state_repository.get_onboarding_state()
    return state or {}

@router.post(
    "/setup/onboarding-state",
    summary="Save onboarding UI state",
    description="Saves the current onboarding UI state.",
)
def save_onboarding_state(
    payload: Dict[str, Any],
    setup_service: SetupService = Depends(get_setup_service)
):
    """Save onboarding UI state."""
    success = setup_service.state_repository.save_onboarding_state(payload)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to save onboarding state")
    return {"status": "ok"}

@router.get(
    "/setup/orchestration-state",
    summary="Get orchestration state",
    description="Returns the current state of the backend setup orchestrator.",
)
async def get_orchestration_state(
    orchestrator: SetupOrchestrator = Depends(get_setup_orchestrator)
):
    """Get setup orchestration state."""
    return orchestrator.get_state()

class OrchestrationCommand(BaseModel):
    command: str

@router.post(
    "/setup/orchestration-command",
    summary="Execute orchestration command",
    description="Send a command to advance or retry the setup state machine.",
)
async def execute_orchestration_command(
    payload: OrchestrationCommand,
    orchestrator: SetupOrchestrator = Depends(get_setup_orchestrator)
):
    """Execute orchestration command."""
    await orchestrator.handle_command(payload.command)
    return {"status": "ok"}

@router.post(
    "/setup/complete",
    summary="Complete onboarding: persist consolidated configuration",
    description="Receives all onboarding data (user profile, legal acceptance, indexing locations, "
                "proactive configs) and persists it to a local JSON file for post-restart processing. "
                "Guarantees persistence even if backend services are currently degraded.",
)
async def complete_onboarding(
    payload: Dict[str, Any],
    setup_service: SetupService = Depends(get_setup_service)
):
    """Submit consolidated onboarding data."""
    try:
        await setup_service.complete_onboarding(payload)
        return {"status": "ok", "message": "Onboarding configuration persisted successfully"}
    except Exception as e:
        logger.error("Failed to complete onboarding: %s", e)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to persist onboarding configuration: {str(e)}"
        )


