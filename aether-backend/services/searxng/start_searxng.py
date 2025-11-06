#!/usr/bin/env python3
import os
import sys
import subprocess
from pathlib import Path

def start_searxng():
    searxng_dir = Path(__file__).parent
    venv_dir = searxng_dir / "venv"
    
    # Activate virtual environment and start SearXNG
    if os.name == 'nt':  # Windows
        python_path = venv_dir / "Scripts" / "python.exe"
    else:
        python_path = venv_dir / "bin" / "python"
    
    webapp_path = searxng_dir / "searx" / "webapp.py"
    
    print("Starting SearXNG on http://127.0.0.1:8888")
    print("Press Ctrl+C to stop")
    
    try:
        subprocess.run([str(python_path), str(webapp_path)], cwd=searxng_dir)
    except KeyboardInterrupt:
        print("\nSearXNG stopped")

if __name__ == "__main__":
    start_searxng()
