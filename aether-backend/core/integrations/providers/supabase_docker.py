"""
Supabase Docker Management Utility

@.architecture
Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/app.py::create_app --- {NoneType, none}
Processing: check_docker_running(), start_supabase_containers(), check_supabase_api_health(), check_redis_health() --- {3 jobs: JOB_HEALTH_CHECK, JOB_INITIALIZE_COMPONENT, JOB_MANAGE_TASK}
Outgoing: docker compose CLI, http://localhost:54321/rest/v1/, /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/app.py::create_app --- {bool, status}
"""

import os
import subprocess
import time
import asyncio
import httpx
import sys
from pathlib import Path
from typing import Optional, Tuple

from monitoring import get_logger

logger = get_logger(__name__)

# Packaged-aware path resolution
def get_resource_path(relative_path: str) -> Path:
    """Get absolute path to resource, works for dev and PyInstaller.
    
    In production (frozen binary), paths resolve through AETHER_BACKEND_ROOT
    (writable data dir) first, then AETHER_INSTALL_DIR (read-only bundle dir),
    then _MEIPASS (PyInstaller internal) as last resort.
    
    For CONFIG files (local.env): must be in AETHER_BACKEND_ROOT (writable).
    For DOCKER files (compose): can be in AETHER_INSTALL_DIR (read-only, shipped with app).
    """
    if hasattr(sys, '_MEIPASS'):
        # Production: check writable data dir first (AETHER_BACKEND_ROOT),
        # then read-only install dir (AETHER_INSTALL_DIR), then _MEIPASS.
        for env_var in ('AETHER_BACKEND_ROOT', 'AETHER_INSTALL_DIR'):
            base = os.environ.get(env_var)
            if base:
                candidate = Path(base) / relative_path
                if candidate.exists():
                    return candidate
        # Fallback to _MEIPASS (inside PyInstaller bundle)
        return Path(sys._MEIPASS) / relative_path
    return Path(__file__).parent.parent.parent.parent / relative_path

# Supabase Docker directory (External Services Mesh)
SUPABASE_DOCKER_DIR = get_resource_path("services/external-services")
SUPABASE_ENV_FILE = get_resource_path("config/local.env")


def get_docker_postgres_port() -> Optional[int]:
    """
    Query Docker to get actual mapped Postgres port.
    
    Returns:
        int: Host-mapped port number (e.g., 55432), or None if container not running
    """
    try:
        result = subprocess.run(
            ["docker", "port", "supabase-db", "5432"],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0:
            # Output format: "0.0.0.0:55432"
            port_mapping = result.stdout.strip()
            if ":" in port_mapping:
                port = int(port_mapping.split(":")[-1])
                logger.debug("Docker Postgres mapped to host port: %s", port)
                return port
        
        return None
    except Exception as e:
        logger.warning("Failed to query Docker port mapping: %s", e)
        return None


def get_docker_postgres_password() -> Optional[str]:
    """
    Query Docker container's environment to get actual Postgres password.
    
    Returns:
        str: Password currently set in container, or None if cannot retrieve
    """
    try:
        result = subprocess.run(
            ["docker", "exec", "supabase-db", "env"],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0:
            for line in result.stdout.split('\n'):
                if line.startswith("POSTGRES_PASSWORD="):
                    password = line.split("=", 1)[1]
                    logger.debug("Retrieved Postgres password from container")
                    return password
        
        return None
    except Exception as e:
        logger.warning("Failed to query Docker container password: %s", e)
        return None


def verify_config_sync() -> Tuple[bool, str]:
    """
    Verify Docker containers are using same configuration as local.env.
    
    Returns:
        Tuple[bool, str]: (is_synced, message)
    """
    if not SUPABASE_ENV_FILE.exists():
        return False, f"Configuration file not found: {SUPABASE_ENV_FILE}"
    
    # Load expected password from local.env
    try:
        with open(SUPABASE_ENV_FILE, 'r') as f:
            for line in f:
                if line.startswith("POSTGRES_PASSWORD="):
                    expected_password = line.split("=", 1)[1].strip()
                    break
            else:
                return False, "POSTGRES_PASSWORD not found in local.env"
    except Exception as e:
        return False, f"Failed to read local.env: {e}"
    
    # Get actual password from Docker container
    actual_password = get_docker_postgres_password()
    
    if actual_password is None:
        return False, "Cannot retrieve password from Docker container (not running?)"
    
    if actual_password != expected_password:
        return False, f"Password mismatch: container using old password (length {len(actual_password)}) vs local.env (length {len(expected_password)})"
    
    return True, "Configuration synchronized"


def force_config_resync() -> bool:
    """
    Force Docker containers to reload configuration from local.env.
    
    This recreates the database container with fresh config.
    WARNING: This will delete all data in the database!
    
    SAFETY: NEVER runs in packaged/frozen builds. The production startup script
    manages Docker lifecycle. This function is for development mode only.
    
    Returns:
        bool: True if resync successful, False otherwise
    """
    # CRITICAL SAFETY GUARD: Never destroy DB in packaged builds.
    # In production, start_production.sh manages Docker. The backend must not
    # stop/recreate containers — it only connects to already-running services.
    if getattr(sys, 'frozen', False):
        logger.error(
            "force_config_resync() called in frozen/packaged build — BLOCKED. "
            "The production startup script manages Docker lifecycle. "
            "This function must never run in production."
        )
        return False
    
    try:
        logger.warning("🔄 Forcing configuration resync - this will recreate database container")
        
        if not SUPABASE_DOCKER_DIR.exists():
            logger.error("Cannot resync: directory not found at %s", SUPABASE_DOCKER_DIR)
            return False
        
        # Step 1: Stop database container
        logger.info("Stopping database container...")
        result = subprocess.run(
            [*_compose_base_cmd(), "stop", "db"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            logger.error("Failed to stop database: %s", result.stderr)
            return False
        
        # Step 2: Remove database container and volumes
        logger.info("Removing database container and volumes...")
        result = subprocess.run(
            [*_compose_base_cmd(), "rm", "-f", "-v", "db"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if result.returncode != 0:
            logger.error("Failed to remove database container: %s", result.stderr)
            return False
        
        # Step 3: Delete database data directory (force fresh init)
        db_data_dir = SUPABASE_DOCKER_DIR / "volumes" / "db" / "data"
        if db_data_dir.exists():
            logger.info("Deleting database data directory: %s", db_data_dir)
            import shutil
            shutil.rmtree(db_data_dir)
        
        # Step 4: Recreate database container with new config
        logger.info("Recreating database container with current configuration...")
        result = subprocess.run(
            [*_compose_base_cmd(), "up", "-d", "db"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=120
        )
        
        if result.returncode != 0:
            logger.error("Failed to recreate database container: %s", result.stderr)
            return False
        
        logger.info("✅ Configuration resync complete - database container recreated")
        return True
        
    except Exception as e:
        logger.error("Failed to force config resync: %s", e)
        return False


def _compose_base_cmd() -> list[str]:
    cmd = ["docker", "compose"]
    # Fail-fast: always pass our env file so Supabase keys match backend config.
    if SUPABASE_ENV_FILE.exists():
        cmd += ["--env-file", str(SUPABASE_ENV_FILE)]
    return cmd


def check_docker_running() -> bool:
    """
    Check if Docker daemon is running.
    
    Returns:
        bool: True if Docker is running, False otherwise
    """
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            timeout=5
        )
        return result.returncode == 0
    except Exception as e:
        logger.warning("Failed to check Docker status: %s", e)
        return False


def check_supabase_containers() -> Tuple[bool, int]:
    """
    Check if Supabase containers are running.
    
    Returns:
        Tuple[bool, int]: (all_healthy, container_count)
    """
    try:
        if not SUPABASE_DOCKER_DIR.exists():
            # In packaged production, the docker directory might be external or managed by Electron.
            # We skip the 'ps' check and rely on API health check later.
            logger.debug("Supabase docker directory not found: %s", SUPABASE_DOCKER_DIR)
            return False, 0

        result = subprocess.run(
            [*_compose_base_cmd(), "ps", "--format", "json"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode != 0:
            return False, 0
        
        import json
        containers = []
        for line in result.stdout.strip().split('\n'):
            if line:
                try:
                    containers.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        
        if not containers:
            return False, 0
        
        # Check if critical services are running (not necessarily healthy)
        critical_services = {
            'supabase-db',
            'supabase-kong',
            'supabase-rest',
            'supabase-auth',
            'supabase-redis',
        }
        running_services = {c['Name'] for c in containers if 'Up' in c.get('State', '')}
        
        all_critical_running = critical_services.issubset(running_services)
        
        # Also check if db is healthy
        db_healthy = False
        for c in containers:
            if c['Name'] == 'supabase-db':
                # State might be "Up 2 minutes (healthy)"
                if '(healthy)' in c.get('State', '') or c.get('Health') == 'healthy':
                    db_healthy = True
                break

        return all_critical_running and db_healthy, len(containers)
        
    except Exception as e:
        logger.warning("Failed to check Supabase containers: %s", e)
        return False, 0


async def check_supabase_api_health(
    url: str = "http://localhost:54321",
    anon_key: str = ""
) -> bool:
    """
    Check if Supabase API is responding.
    
    Args:
        url: Supabase base URL
        anon_key: Supabase anon key for authentication
        
    Returns:
        bool: True if API is healthy, False otherwise
    """
    try:
        if not anon_key:
            # Fallback: check if we can get it from env if not provided
            anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
            
        async with httpx.AsyncClient(timeout=5.0) as client:
            headers = {
                "apikey": anon_key,
                "Authorization": f"Bearer {anon_key}"
            }
            # Test Kong gateway root - should respond if Supabase is up
            response = await client.get(f"{url}/", headers=headers)
            
            # 200 is ideal, but 401/404 from Kong also means it's ALIVE
            # The database client initialization will perform the final validation.
            return response.status_code in [200, 401, 404]
    except Exception as e:
        logger.debug("Supabase API health check failed: %s", e)
        return False


async def check_redis_health(redis_url: str, namespace: str = "aether") -> bool:
    """
    Check if Redis cache is responding.

    Args:
        redis_url: Redis connection URL
        namespace: Cache namespace for RedisCache

    Returns:
        bool: True if Redis is healthy, False otherwise
    """
    # Integrations layer must not depend on cache_layer implementation.
    # Health check here is a minimal socket-level verification (and best-effort PING).
    try:
        from urllib.parse import urlparse

        parsed = urlparse(redis_url)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 6379

        reader, writer = await asyncio.open_connection(host, port)
        try:
            # RESP PING: *1\r\n$4\r\nPING\r\n
            writer.write(b"*1\r\n$4\r\nPING\r\n")
            await writer.drain()
            resp = await asyncio.wait_for(reader.readline(), timeout=2.0)
            return resp.startswith(b"+PONG")
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
    except Exception as exc:
        logger.debug("Redis health check failed: %s", exc)
        return False


def start_supabase_containers() -> bool:
    """
    Start Supabase Docker containers.
    
    Uses `start` for existing containers to avoid recreation/corruption.
    Falls back to `up -d` only if containers don't exist yet (first run).
    
    Returns:
        bool: True if started successfully, False otherwise
    """
    try:
        if not SUPABASE_DOCKER_DIR.exists():
            logger.error("Cannot start Supabase: directory not found at %s", SUPABASE_DOCKER_DIR)
            return False

        logger.info("Starting Supabase Docker containers...")
        
        # Try `docker compose start` first (doesn't recreate, just starts existing containers)
        result = subprocess.run(
            [*_compose_base_cmd(), "start"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=60
        )
        
        # If start succeeded, verify containers are actually running
        if result.returncode == 0:
            # Give containers a moment to start
            import time
            time.sleep(2)
            
            # Check if critical services came up
            is_running, count = check_supabase_containers()
            if is_running and count > 0:
                logger.info("Supabase containers started (%d services)", count)
                return True
        
        # If `start` failed or no containers exist, use `up -d` (first run)
        logger.info("Containers not initialized, running first-time setup...")
        result = subprocess.run(
            [*_compose_base_cmd(), "up", "-d", "--no-recreate"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=120  # 2 minutes timeout for pulling images
        )
        
        if result.returncode != 0:
            logger.error("Failed to start Supabase: %s", result.stderr)
            return False
        
        logger.info("✅ Supabase containers initialized and started")
        return True
        
    except subprocess.TimeoutExpired:
        logger.error("Timeout while starting Supabase containers")
        return False
    except Exception as e:
        logger.error("Failed to start Supabase containers: %s", e)
        return False


async def ensure_supabase_running(
    url: str = "http://localhost:54321",
    anon_key: str = "",
    redis_url: Optional[str] = None,
    redis_namespace: str = "aether",
    max_wait_seconds: int = 60,
    auto_resync_on_mismatch: bool = True
) -> bool:
    """
    Ensure Supabase is running, starting it if necessary.
    
    This function operates in two modes:
    
    **Production Mode (DISABLE_DOCKER_MANAGEMENT=true)**:
    - ONLY performs health checks
    - NEVER starts/stops containers
    - Assumes orchestrator (Electron/shell script) manages Docker lifecycle
    - Fails fast if services unavailable
    
    **Development Mode (DISABLE_DOCKER_MANAGEMENT=false/unset)**:
    - Auto-manages Docker containers
    - Verifies config sync, starts containers if needed
    - Useful for quick local dev iterations
    
    Args:
        url: Supabase base URL
        anon_key: Supabase anon key for authentication
        redis_url: Redis connection URL
        redis_namespace: Redis namespace for cache
        max_wait_seconds: Maximum time to wait for startup
        auto_resync_on_mismatch: Automatically recreate containers if config mismatch detected (dev mode only)
        
    Returns:
        bool: True if Supabase is running and healthy, False otherwise
    """
    import os
    
    # Check if Docker management is disabled (production/orchestrated mode)
    disable_docker_mgmt = os.getenv("DISABLE_DOCKER_MANAGEMENT", "false").lower() in ("true", "1", "yes")
    
    # CRITICAL: Check if we should skip health checks entirely (used during first-run setup)
    skip_health_check = os.getenv("SKIP_SERVICE_HEALTH_CHECK", "false").lower() in ("true", "1", "yes")
    
    if skip_health_check:
        logger.warning("⚠️  SKIP_SERVICE_HEALTH_CHECK enabled - bypassing all service health checks")
        logger.warning("   This should ONLY be used during initial setup phase")
        logger.warning("   Backend will start without verifying external services")
        return True  # Pretend services are ready
    
    if disable_docker_mgmt:
        logger.info("🔒 Docker management disabled - running in orchestrated mode")
        logger.info("   Backend will only verify service health, not manage containers")
        
        # PRODUCTION MODE: Wait for external orchestrator to bring services online
        if not anon_key:
            logger.error("Supabase anon_key is required (configure SUPABASE_ANON_KEY in config/local.env).")
            return False
        
        redis_url = redis_url or "redis://localhost:6379/0"
        
        # Robust health check with retry and exponential backoff
        logger.info("Waiting for external services to become healthy (max %ds)...", max_wait_seconds)
        
        start_time = time.time()
        retry_count = 0
        backoff_seconds = 1
        max_backoff = 10
        
        api_ready = False
        redis_ready = False
        
        while time.time() - start_time < max_wait_seconds:
            # Check both services
            api_ready = await check_supabase_api_health(url, anon_key)
            redis_ready = await check_redis_health(redis_url, namespace=redis_namespace)
            
            if api_ready and redis_ready:
                elapsed = time.time() - start_time
                logger.info("All external services healthy (took %.1fs)", elapsed)
                return True
            
            # Log what's not ready yet
            not_ready = []
            if not api_ready:
                not_ready.append("Supabase API")
            if not redis_ready:
                not_ready.append("Redis")
            
            retry_count += 1
            remaining = max_wait_seconds - (time.time() - start_time)
            
            if remaining <= 0:
                break
            
            logger.info("Waiting for: %s (retry %d, next check in %ds)", ", ".join(not_ready), retry_count, backoff_seconds)
            
            # Sleep with backoff, but don't exceed remaining time
            await asyncio.sleep(min(backoff_seconds, remaining))
            
            # Exponential backoff up to max_backoff
            backoff_seconds = min(backoff_seconds * 1.5, max_backoff)
        
        # Timeout reached - report what failed
        logger.error("External services did not become healthy within %ds", max_wait_seconds)
        if not api_ready:
            logger.error("   - Supabase API not responding")
        if not redis_ready:
            logger.error("   - Redis not responding")
        logger.error("   Ensure external orchestrator has started all services")
        return False
    
    # DEVELOPMENT MODE: Auto-manage containers
    logger.info("🔧 Docker management enabled - running in auto-managed mode")
    
    # Check Docker daemon
    if not check_docker_running():
        logger.error("Docker daemon is not running. Please start Docker Desktop.")
        return False

    if not anon_key:
        logger.error("Supabase anon_key is required (configure SUPABASE_ANON_KEY in config/local.env).")
        return False

    redis_url = redis_url or "redis://localhost:6379/0"
    
    # CRITICAL: Verify configuration synchronization
    is_synced, sync_message = verify_config_sync()
    
    if not is_synced:
        logger.warning("Configuration mismatch detected: %s", sync_message)
        
        if auto_resync_on_mismatch:
            logger.info("🔄 Auto-resyncing configuration (will recreate database)...")
            if not force_config_resync():
                logger.error("❌ Failed to resync configuration")
                return False
            logger.info("✅ Configuration resynced successfully")
        else:
            logger.error("Configuration mismatch detected but auto_resync disabled")
            logger.error("Run: python -m scripts.generate_keys to regenerate config")
            logger.error("Or restart with auto_resync_on_mismatch=True")
            return False
    else:
        logger.info("Configuration synchronized: %s", sync_message)
    
    # Check if Supabase containers are already running
    is_running, container_count = check_supabase_containers()
    
    if is_running:
        logger.info("Supabase is already running (%d containers)", container_count)
        
        # Quick health check
        if await check_supabase_api_health(url, anon_key):
            logger.info("✅ Supabase API is healthy")
            # Fail-fast: Supabase "running" is not acceptable if its Redis cache is unhealthy.
            # This is required for traceability and runtime caching correctness.
            if not await check_redis_health(redis_url, namespace=redis_namespace):
                logger.error("❌ Supabase Redis cache is not healthy")
                return False
            return True
        else:
            logger.warning("Supabase containers running but API not responding yet...")
    else:
        logger.info("Supabase not running, starting containers...")
        
        if not start_supabase_containers():
            logger.error("Failed to start Supabase containers")
            return False
    
    # Wait for API to become healthy
    logger.info("Waiting for Supabase API to become healthy (max %ds)...", max_wait_seconds)
    
    start_time = time.time()
    api_ready = False
    redis_ready = False
    
    while time.time() - start_time < max_wait_seconds:
        api_ready = await check_supabase_api_health(url, anon_key)
        redis_ready = await check_redis_health(redis_url, namespace=redis_namespace)

        if api_ready and redis_ready:
            elapsed = time.time() - start_time
            logger.info("Supabase API and Redis cache are healthy (took %.1fs)", elapsed)
            return True

        # Log what's still pending
        if not api_ready:
            logger.debug("Waiting for Supabase API...")
        if not redis_ready:
            logger.debug("Waiting for Redis...")
        
        await asyncio.sleep(2)
    
    # Timeout reached - report what failed
    missing_components = []
    if not api_ready:
        missing_components.append("Supabase API")
    if not redis_ready:
        missing_components.append("Redis cache")

    logger.error(
        f"{', '.join(missing_components) if missing_components else 'Unknown components'} did not become healthy within {max_wait_seconds}s"
    )
    return False


def stop_supabase_containers(timeout_seconds: int = 45) -> bool:
    """
    Stop the entire Docker mesh (Supabase + Perplexica + SearXNG) gracefully.
    
    Uses `docker compose down` to stop AND remove containers/networks for a
    clean machine state. Volumes are preserved (no --volumes flag) so data
    survives across app restarts.
    
    Args:
        timeout_seconds: Max seconds for the entire subprocess command to finish.
    
    Returns:
        bool: True if stopped successfully, False otherwise
    """
    try:
        if not SUPABASE_DOCKER_DIR.exists():
            logger.error("Cannot stop Docker mesh: directory not found at %s", SUPABASE_DOCKER_DIR)
            return False

        logger.info("Stopping Docker mesh (Supabase + Perplexica + SearXNG)...")
        
        # --timeout 5: per-container grace period before SIGKILL.
        # Reduced from 10s to fit within the cumulative Electron shutdown budget.
        result = subprocess.run(
            [*_compose_base_cmd(), "down", "--timeout", "5", "--remove-orphans"],
            cwd=str(SUPABASE_DOCKER_DIR),
            capture_output=True,
            text=True,
            timeout=timeout_seconds
        )
        
        if result.returncode != 0:
            logger.error("Failed to stop Docker mesh: %s", result.stderr)
            return False
        
        logger.info("Docker mesh stopped and cleaned up")
        return True
        
    except subprocess.TimeoutExpired:
        logger.error("Timeout (%ds) while stopping Docker mesh", timeout_seconds)
        return False
    except Exception as e:
        logger.error("Failed to stop Docker mesh: %s", e)
        return False


# For manual testing
if __name__ == "__main__":
    import asyncio
    
    async def test():
        logger.info("Testing Supabase Docker management...")
        success = await ensure_supabase_running()
        if success:
            logger.info("✅ Supabase is running and healthy")
        else:
            logger.error("❌ Failed to ensure Supabase is running")
    
    asyncio.run(test())

