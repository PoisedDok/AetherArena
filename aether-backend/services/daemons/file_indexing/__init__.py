"""
@.architecture
Incoming: services/file_indexing/daemon.py, CLI invocation --- {python module import}
Processing: expose service components --- {1 job: JOB_ORCHESTRATE}
Outgoing: services/file_indexing/daemon.py --- {ModuleType, python}
"""

from .config import IndexingServiceConfig

__all__ = ["IndexingServiceConfig"]

