"""
API Dependencies

FastAPI dependency injection container managing singletons and request-scoped resources.
Provides runtime engine, MCP manager, database gateway, auth context, and observability hooks.

@.architecture
Incoming: app.py, api/v1/endpoints/*.py, Request lifecycle --- {HTTPRequest, Settings, dependency_injection}
Processing: get_runtime_engine(), get_database(), get_auth_context(), setup_request_context() --- {5 jobs: JOB_AUTHORIZE, JOB_LOAD_CONFIG, JOB_MANAGE_CONNECTION, JOB_ORCHESTRATE, JOB_TRACE}
Outgoing: api/v1/endpoints/*.py, monitoring/logging.py --- {RuntimeEngine, SupabasePersistenceGateway, AuthorizationContext, correlation_id}
"""

from typing import AsyncGenerator, Optional, Dict, Any
from fastapi import Depends, HTTPException, Header, Request, status
import os
import uuid
import threading

_init_lock = threading.Lock()

from data.database.uow import SupabaseUnitOfWork, SupabaseRequestContext
from data.cache import RedisSessionContext, RedisRequestContext
from application.chat import ChatService
from application.chat.summary_service import ChatSummaryService
from application.omni import OmniService
from config.settings import Settings, get_settings as load_settings
from core.runtime.engine import RuntimeEngine
from core.mcp.manager import MCPServerManager
from core.mcp.context import get_mcp_manager as _get_mcp_manager
from monitoring import get_logger, set_request_context, clear_request_context
from data.database.persistence_gateway import SupabasePersistenceGateway
from security.auth import AuthConfig, AuthenticationManager, AuthenticationError, get_auth_manager
from security.permissions import AuthorizationContext, User, Role, get_permission_manager
from data.network.search_gateway import get_search_gateway
from core.domain.gateway_interfaces import ISearchGateway
from core.system.interfaces import IProcessGateway

logger = get_logger(__name__)


# =============================================================================
# Settings Dependencies
# =============================================================================

from .di.core import (
    shutdown_runtime_settings_service,
    get_settings,
    get_runtime_settings,
)


from .di.security import (
    require_local_request,
    require_local_request_dependency,
)

# =============================================================================
# Runtime Engine Dependencies
# =============================================================================

from .di.system import (
    set_runtime_engine,
    get_runtime_engine,
)


# =============================================================================
# MCP Manager Dependencies
# =============================================================================

from .di.agents import (
    get_mcp_manager,
    require_mcp_manager,
)


# =============================================================================
# File Indexing Repository Dependencies
# =============================================================================

from .di.files import (
    set_file_indexing_repository,
    get_file_indexing_repository,
    require_file_indexing_repository,
    get_index_service,
    get_notebook_service,
)

# =============================================================================
# Tool Service Dependencies
# =============================================================================

from .di.agents import (
    get_tool_service,
    shutdown_tool_service,
)

# =============================================================================
# Database Dependencies (Supabase Gateway)
# =============================================================================

from .di.database import (
    set_database_connection,
    get_database_connection,
    get_database,
)


# =============================================================================
# Research Service Dependencies
# =============================================================================

from .di.search import (
    get_search_indexes_repository,
    get_source_indexing_service,
    get_research_service,
)


# =============================================================================
# Chat Repository Dependencies
# =============================================================================

from .di.chat import get_chat_repository


# =============================================================================
# Daemon Logs Repository Dependencies
# =============================================================================

from .di.agents import get_daemon_logs_repository


# =============================================================================
# Unit of Work Dependencies
# =============================================================================

from .di.database import (
    get_supabase_uow,
    get_redis_session,
)


# =============================================================================
# Chat Services
# =============================================================================

from .di.chat import (
    get_chat_service,
    get_summary_service,
)


# =============================================================================
# Cache Dependencies (Redis)
# =============================================================================

from .di.database import (
    set_cache_client,
    get_cache_client,
)


# =============================================================================
# Authentication Dependencies
# =============================================================================

from .di.security import (
    require_auth_context,
    get_anonymous_context,
)


# =============================================================================
# Request Context Dependencies
# =============================================================================

from .di.core import (
    setup_request_context,
    cleanup_request_context,
    _build_request_context_payload,
)


# =============================================================================
# Pagination Dependencies
# =============================================================================

from .di.core import (
    PaginationParams,
    get_pagination_params,
)


# =============================================================================
# Rate Limiting Dependencies (Future)
# =============================================================================

from .di.security import check_rate_limit


# =============================================================================
# Search Orchestrator Dependencies
# =============================================================================

from .di.search import get_search_orchestrator


# =============================================================================
# Process Gateway Dependencies
# =============================================================================

from .di.system import get_process_gateway

# =============================================================================
# Terminal Service Dependencies
# =============================================================================

from .di.system import get_terminal_service

# =============================================================================
# Setup Service Dependencies
# =============================================================================

from .di.chat import (
    get_setup_service,
    get_setup_orchestrator,
)


# =============================================================================
# File Service Dependencies
# =============================================================================

from .di.files import (
    get_file_service,
    get_optional_file_service,
)

# =============================================================================
# Skill Service Dependencies
# =============================================================================

from .di.agents import get_skill_service

# =============================================================================
# Daemon Service Dependencies
# =============================================================================

from .di.agents import get_daemon_service

# =============================================================================
# Proactive Service Dependencies
# =============================================================================

from .di.agents import (
    get_proactive_service,
    get_proactive_service_for_background,
    get_proactive_config_service,
)

# =============================================================================
# Storage Service Dependencies
# =============================================================================

from .di.files import get_storage_service


# =============================================================================
# Preferences Service Dependencies
# =============================================================================

from .di.chat import get_preferences_service


# =============================================================================
# Omni Service Dependencies
# =============================================================================

from .di.agents import (
    get_omni_service,
    shutdown_omni_service,
)


# =============================================================================
# Registry Gateway Dependencies
# =============================================================================

from .di.system import get_registry_gateway
from .di.chat import get_profile_repository


# =============================================================================
# HTTP Client Dependencies
# =============================================================================

from .di.system import (
    get_http_client,
    close_http_client,
)


