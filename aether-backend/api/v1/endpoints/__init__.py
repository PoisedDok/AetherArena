"""
API V1 Endpoints

FastAPI routers for all API endpoints.
"""

from .health import router as health_router
from .settings import router as settings_router
from .models import router as models_router
from .mcp import router as mcp_router
from .chat import router as chat_router
from .files import router as files_router
from .profiles import router as profiles_router
from .skills import router as skills_router
from .terminal import router as terminal_router
from .storage import router as storage_router
from .tts import router as tts_router
from .ocr import router as ocr_router
from .notebook import router as notebook_router
from .omni import router as omni_router
from .xlwings_api import router as xlwings_router
from .backends import router as backends_router

__all__ = [
    "health_router",
    "settings_router",
    "models_router",
    "mcp_router",
    "chat_router",
    "files_router",
    "profiles_router",
    "skills_router",
    "terminal_router",
    "storage_router",
    "tts_router",
    "ocr_router",
    "notebook_router",
    "omni_router",
    "xlwings_router",
    "backends_router",
]

