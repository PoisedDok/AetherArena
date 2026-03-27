"""
@.architecture
Incoming: services/file_indexing/daemon.py --- {python module import}
Processing: expose database client --- {1 job: JOB_ORCHESTRATE}
Outgoing: services/file_indexing/daemon.py --- {ModuleType, python}
"""

from .client import create_supabase_client

__all__ = ["create_supabase_client"]

