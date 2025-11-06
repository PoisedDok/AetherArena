"""
Main entry point for Aether Backend

Imports the FastAPI app from app.py for uvicorn to run.

@.architecture
Incoming: none --- {entry point for uvicorn server}
Processing: create_app() import, uvicorn.run() --- {2 jobs: config_loading, server_startup}
Outgoing: uvicorn server, Network (HTTP/WebSocket) --- {FastAPI application instance, HTTP/WebSocket server}
"""

import os
from app import create_app
from config.settings import get_settings

# Create app instance
app = create_app()

if __name__ == "__main__":
    import uvicorn
    
    # Get settings for port configuration
    settings = get_settings()
    
    # Use environment variable or settings, no hardcoded port
    host = os.getenv("AETHER_HOST", settings.security.bind_host)
    port = int(os.getenv("AETHER_PORT", str(settings.security.bind_port)))
    reload = os.getenv("AETHER_RELOAD", "true").lower() == "true"
    log_level = os.getenv("AETHER_LOG_LEVEL", "info")
    
    uvicorn.run(
        "main:app",
        host=host,
        port=port,
        reload=reload,
        log_level=log_level
    )
