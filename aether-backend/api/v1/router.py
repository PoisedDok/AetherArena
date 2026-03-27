"""
API V1 Router

Aggregates all v1 endpoint routers into a single versioned API.

@.architecture
Incoming: app.py, api/v1/endpoints/*.py --- {app.include_router() call, 44 endpoint router instances}
Processing: api_v1_router.include_router() for 44 routers across 36 endpoint modules --- {JOB_ORCHESTRATE}
Outgoing: app.py, api/v1/endpoints/*.py --- {APIRouter with /v1 prefix, HTTP request routing to endpoints}
"""

from fastapi import APIRouter, Depends
from api.dependencies import require_local_request_dependency

from .endpoints import (
    agent_action_router,
    agents_router,
    api_docs_router,
    backends_router,
    chat_action_router,
    chat_references_router,
    chat_router,
    context_router,
    document_action_router,
    document_router,
    file_action_router,
    files_router,
    health_router,
    indexes_router,
    inference_router,
    llm_providers_router,
    llm_router,
    mcp_router,
    memories_router,
    models_router,
    notebook_action_router,
    notebook_router,
    omni_router,
    preferences_router,
    proactive_router,
    profiles_router,
    research_router,
    search_router,
    services_router,
    settings_router,
    setup_router,
    skills_router,
    sources_router,
    storage_router,
    terminal_router,
    toolrunner_action_router,
    toolrunner_router,
    tts_router,
    user_credentials_router,
    utils_router,
    workers_router,
    xlwings_router
)

# Create v1 router
api_v1_router = APIRouter(
    prefix="/v1",
    dependencies=[Depends(require_local_request_dependency)]
)


# Include all endpoint routers

# Agents
api_v1_router.include_router(agents_router)
api_v1_router.include_router(agent_action_router)

# API Documentation 
api_v1_router.include_router(api_docs_router)

# Backends Registry
api_v1_router.include_router(backends_router)

# Chat References
api_v1_router.include_router(chat_references_router)

# Chat
api_v1_router.include_router(chat_router)
api_v1_router.include_router(chat_action_router)

# Context 
api_v1_router.include_router(context_router)

# Document processing
api_v1_router.include_router(document_router)
api_v1_router.include_router(document_action_router)

# Files
api_v1_router.include_router(files_router)
api_v1_router.include_router(file_action_router)
#

# Health
api_v1_router.include_router(health_router)

# Indexes
api_v1_router.include_router(indexes_router)

# Aether Inference
api_v1_router.include_router(inference_router)

# LLM Providers
api_v1_router.include_router(llm_providers_router)

# LLM Proxy
api_v1_router.include_router(llm_router)

# MCP 
api_v1_router.include_router(mcp_router)

# Memories
api_v1_router.include_router(memories_router)

# Models
api_v1_router.include_router(models_router)

# Notebook
api_v1_router.include_router(notebook_router)
api_v1_router.include_router(notebook_action_router)

# Omni
api_v1_router.include_router(omni_router)

# Preferences
api_v1_router.include_router(preferences_router)

# Proactive
api_v1_router.include_router(proactive_router)

# Profiles
api_v1_router.include_router(profiles_router)

# Research
api_v1_router.include_router(research_router)

# Search
api_v1_router.include_router(search_router)

# Services Status
api_v1_router.include_router(services_router)

# Settings
api_v1_router.include_router(settings_router)

# Setup
api_v1_router.include_router(setup_router)

# Skills
api_v1_router.include_router(skills_router)

# Sources
api_v1_router.include_router(sources_router)

# Storage 
api_v1_router.include_router(storage_router)

# Terminal
api_v1_router.include_router(terminal_router)

# Tool Runner
api_v1_router.include_router(toolrunner_router)
api_v1_router.include_router(toolrunner_action_router)

# TTS
api_v1_router.include_router(tts_router)

# User Credentials
api_v1_router.include_router(user_credentials_router)

# Utils
api_v1_router.include_router(utils_router)

# Workers
api_v1_router.include_router(workers_router)

# XLWings
api_v1_router.include_router(xlwings_router)

