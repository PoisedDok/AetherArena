"""
API V1 Router

Aggregates all v1 endpoint routers into a single versioned API.

@.architecture
Incoming: app.py, api/v1/endpoints/*.py --- {app.include_router() call, 16 endpoint router instances}
Processing: api_v1_router.include_router() for 16 endpoints --- {1 job: router_aggregation}
Outgoing: app.py, api/v1/endpoints/*.py --- {APIRouter with /v1 prefix, HTTP request routing to endpoints}
"""

from fastapi import APIRouter

from .endpoints import (
    health_router,
    settings_router,
    models_router,
    mcp_router,
    chat_router,
    files_router,
    profiles_router,
    skills_router,
    terminal_router,
    storage_router,
    tts_router,
    ocr_router,
    notebook_router,
    omni_router,
    xlwings_router,
    backends_router
)

# Create v1 router
api_v1_router = APIRouter(prefix="/v1")

# Include all endpoint routers
# Note: Some routers have their own prefixes defined

# Health (no prefix, at root level too)
api_v1_router.include_router(health_router)

# Settings
api_v1_router.include_router(settings_router)

# Models
api_v1_router.include_router(models_router)

# Profiles
api_v1_router.include_router(profiles_router)

# Skills
api_v1_router.include_router(skills_router)

# Terminal
api_v1_router.include_router(terminal_router)

# Files
api_v1_router.include_router(files_router)

# MCP (has /api/mcp prefix)
api_v1_router.include_router(mcp_router)

# Chat (no additional prefix - routes defined in endpoint file)
api_v1_router.include_router(chat_router)

# Storage (has /api/storage prefix)
api_v1_router.include_router(storage_router)

# TTS (text-to-speech)
api_v1_router.include_router(tts_router)

# OCR (document processing)
api_v1_router.include_router(ocr_router)

# Notebook (Python runtime)
api_v1_router.include_router(notebook_router)

# Omni (OmniParser vision tools)
api_v1_router.include_router(omni_router)

# XLWings (Excel automation)
api_v1_router.include_router(xlwings_router)

# Backends Registry (unified sub-backends management)
api_v1_router.include_router(backends_router)

