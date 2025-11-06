#!/usr/bin/env python3
"""
xlwings Backend Service Startup Script
=====================================

Simple script to start the xlwings backend service with proper configuration.
"""

import os
import sys
import subprocess
from pathlib import Path

def main():
    """Start the xlwings backend service"""
    script_dir = Path(__file__).parent
    server_script = script_dir / "xlwings_api_server.py"

    if not server_script.exists():
        print("❌ Error: xlwings_api_server.py not found!")
        return 1

    print("🚀 Starting xlwings Backend Service...")
    print(f"📁 Working directory: {script_dir}")
    print("🌐 Service will be available at: http://localhost:8001"
    print("📚 API documentation at: http://localhost:8001/docs"
    print("🔄 Press Ctrl+C to stop the service"
    print("-" * 50)

    try:
        # Change to the script directory
        os.chdir(script_dir)

        # Start the server
        cmd = [sys.executable, str(server_script)]
        result = subprocess.run(cmd, check=True)

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
