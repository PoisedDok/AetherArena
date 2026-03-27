"""
Supabase Key Synchronization Manager

Responsible for ensuring backend and Supabase Docker configurations
use matching JWT secrets and API keys.

@.architecture
Incoming: services/supabase/docker/.env --- {File contents}
Processing: Parse keys, compare with current env, update .env if needed --- {JOB_INITIALIZE_COMPONENT}
Outgoing: .env --- {Updated file contents}
"""

import os
from pathlib import Path
from monitoring import get_logger

logger = get_logger(__name__)

def sync_supabase_keys():
    """
    Sync JWT keys from Supabase Docker .env to backend .env.
    This ensures authentication consistency across the stack.
    """
    try:
        # In production (frozen binary), Path(__file__) resolves inside the read-only
        # _internal/ directory. Use AETHER_BACKEND_ROOT (writable data dir) for .env
        # and AETHER_INSTALL_DIR / _MEIPASS for bundled Docker env files.
        import sys
        env_root = os.environ.get("AETHER_BACKEND_ROOT")
        if env_root:
            backend_root = Path(env_root)
        else:
            backend_root = Path(__file__).parent.parent.parent
        backend_env_path = backend_root / ".env"
        
        # Docker env: the master .env for all external services (Supabase, Redis, SearXNG)
        # lives at services/external-services/.env — NOT services/supabase/docker/.env.
        # Check writable data dir first, then install dir, then __file__ fallback.
        docker_env_path = None
        docker_env_rel = Path("services") / "external-services" / ".env"
        for candidate_root in [
            backend_root,
            Path(os.environ.get("AETHER_INSTALL_DIR", "")) if os.environ.get("AETHER_INSTALL_DIR") else None,
            Path(getattr(sys, '_MEIPASS', '')) if hasattr(sys, '_MEIPASS') else None,
            Path(__file__).parent.parent.parent,
        ]:
            if candidate_root and (candidate_root / docker_env_rel).exists():
                docker_env_path = candidate_root / docker_env_rel
                break
        
        if docker_env_path is None:
            docker_env_path = backend_root / docker_env_rel

        if not docker_env_path.exists():
            logger.warning("Supabase Docker env not found at %s", docker_env_path)
            return

        if not backend_env_path.exists():
            logger.info("Initializing backend .env from local.env template...")
            local_env = backend_root / "config" / "local.env"
            if local_env.exists():
                import shutil
                shutil.copy(local_env, backend_env_path)
            else:
                backend_env_path.touch()

        # Read Docker keys (Source of Truth)
        docker_env_content = docker_env_path.read_text()
        keys_to_sync = {
            "ANON_KEY": "SUPABASE_ANON_KEY",
            "SERVICE_ROLE_KEY": "SUPABASE_SERVICE_ROLE_KEY",
            "JWT_SECRET": "JWT_SECRET"
        }

        found_keys = {}
        for line in docker_env_content.splitlines():
            if "=" in line:
                key, val = line.split("=", 1)
                if key.strip() in keys_to_sync:
                    found_keys[keys_to_sync[key.strip()]] = val.strip()

        if not found_keys:
            logger.warning("No keys found in Supabase Docker environment")
            return

        # Update backend .env
        backend_env_lines = backend_env_path.read_text().splitlines()
        updated_lines = []
        applied_keys = set()

        for line in backend_env_lines:
            match_found = False
            for target_key, val in found_keys.items():
                if line.startswith(f"{target_key}="):
                    updated_lines.append(f"{target_key}={val}")
                    applied_keys.add(target_key)
                    match_found = True
                    break
            if not match_found:
                updated_lines.append(line)

        # Add missing keys
        for target_key, val in found_keys.items():
            if target_key not in applied_keys:
                updated_lines.append(f"{target_key}={val}")

        new_content = "\n".join(updated_lines) + "\n"
        if new_content != backend_env_path.read_text():
            backend_env_path.write_text(new_content)
            logger.info("✅ Synced Supabase JWT keys to backend .env")
            
            # Update OS environment for current process
            for target_key, val in found_keys.items():
                os.environ[target_key] = val
        else:
            logger.debug("Supabase JWT keys are already in sync")

    except Exception as e:
        logger.error("Failed to sync Supabase keys: %s", e)

if __name__ == "__main__":
    sync_supabase_keys()
