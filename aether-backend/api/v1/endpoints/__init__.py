"""
@.architecture
Incoming: api.v1.router.api_v1_router, api.v1.endpoints.* --- {ModuleType, python}
Processing: expose FastAPI routers for versioned API composition --- {2 jobs: JOB_ROUTE, JOB_VALIDATE_CONFIG}
Outgoing: api.v1.router.api_v1_router --- {ModuleType, python}
"""

from .agents import action_router as agent_action_router
from .agents import router as agents_router
from .api_docs import router as api_docs_router
from .backends import router as backends_router
from .chat import action_router as chat_action_router
from .chat import router as chat_router
from .chat_references import router as chat_references_router
from .context import router as context_router
from .document import action_router as document_action_router
from .document import router as document_router
from .files import action_router as file_action_router
from .files import router as files_router
from .health import router as health_router
from .indexes import router as indexes_router
from .inference import router as inference_router
from .llm import router as llm_router
from .llm_providers import router as llm_providers_router
from .mcp import router as mcp_router
from .memories import router as memories_router
from .models import router as models_router
from .notebook import action_router as notebook_action_router
from .notebook import router as notebook_router
from .omni import router as omni_router
from .preferences import router as preferences_router
from .proactive import router as proactive_router
from .profiles import router as profiles_router
from .research import router as research_router
from .search import router as search_router
from .services import router as services_router
from .setup import router as setup_router
from .settings import router as settings_router
from .skills import router as skills_router
from .storage import router as storage_router
from .sources import router as sources_router
from .terminal import router as terminal_router
from .toolrunner import action_router as toolrunner_action_router
from .toolrunner import router as toolrunner_router
from .tts import router as tts_router
from .user_credentials import router as user_credentials_router
from .workers import router as workers_router
from .utils import router as utils_router
from .xlwings_api import router as xlwings_router

__all__ = [
    "agents_router",
    "agent_action_router",
    "api_docs_router",
    "backends_router",
    "chat_router",
    "chat_action_router",
    "chat_references_router",
    "context_router",
    "document_router",
    "document_action_router",
    "files_router",
    "file_action_router",
    "health_router",
    "indexes_router",
    "inference_router",
    "llm_router",
    "llm_providers_router",
    "mcp_router",
    "memories_router",
    "models_router",
    "notebook_router",
    "notebook_action_router",
    "omni_router",
    "preferences_router",
    "proactive_router",
    "profiles_router",
    "research_router",
    "search_router",
    "services_router",
    "setup_router",
    "settings_router",
    "skills_router",
    "storage_router",
    "sources_router",
    "terminal_router",
    "toolrunner_router",
    "toolrunner_action_router",
    "tts_router",
    "user_credentials_router",
    "utils_router",
    "workers_router",
    "xlwings_router",
]

