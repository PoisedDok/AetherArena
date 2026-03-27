# Incoming: none --- {none, none}
# Processing: none --- {0 jobs: none}
# Outgoing: none --- {none, none}
"""
Docling Integration - Layer 2 Exposure

Exports Docling service and wrapper functions.
"""

from .service import DoclingService, get_docling_service
from .wrapper import docling_convert, docling_health

__all__ = [
    'DoclingService',
    'get_docling_service',
    'docling_convert',
    'docling_health'
]

