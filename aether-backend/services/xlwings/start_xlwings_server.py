#!/usr/bin/env python3
"""
xlwings Backend Service Startup Script
=====================================

Simple script to start the xlwings backend service with proper configuration.
"""

import os
import subprocess
import sys
from pathlib import Path


def main():
    """Start the xlwings backend service"""
    script_dir = Path(__file__).parent
    server_script = script_dir / "xlwings_api_server.py"

    if not server_script.exists():
        print("❌ Error: xlwings_api_server.py not found!")
        return 1

    port = int(os.getenv("XLWINGS_PORT", "8001"))

    print("🚀 Starting xlwings Backend Service...")
    # CRITICAL: Do NOT run from services/xlwings (it contains a vendored `xlwings/` dir).
    # Run from backend root so the venv-installed xlwings is imported consistently.
    backend_root = os.getenv("AETHER_BACKEND_ROOT")
    if backend_root:
        backend_root_path = Path(backend_root).expanduser().resolve()
    else:
        backend_root_path = script_dir.parent.parent  # aether-backend/

    print(f"📁 Working directory: {backend_root_path}")
    print(f"🌐 Service will be available at: http://localhost:{port}")
    print(f"📚 API documentation at: http://localhost:{port}/docs")
    print("🔄 Press Ctrl+C to stop the service")
    print("-" * 50)

    try:
        os.chdir(backend_root_path)

        # Start the server
        cmd = [sys.executable, str(server_script)]
        env = os.environ.copy()
        env.setdefault("XLWINGS_PORT", str(port))
        # Disable uvicorn reload for this subprocess: backend already hot-reloads,
        # and reload mode has caused spawn/import failures.
        env.setdefault("XLWINGS_DEV_MODE", "0")
        # Central-ish default for manual runs (backend sets this explicitly).
        env.setdefault("XLWINGS_BASE_DIR", str((backend_root_path / "data" / "files").resolve()))
        result = subprocess.run(cmd, check=True, env=env)

    except KeyboardInterrupt:
        print("\n🛑 Service stopped by user")
        return 0
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to start service: {e}")
        return 1
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return 1

    return 0

if __name__ == "__main__":
    sys.exit(main())
