"""
Job Handlers

@.architecture
Incoming: job_processor.py --- {job: Dict[str, Any]}
Processing: dispatch to appropriate handler based on job_type --- {1 job: JOB_DELEGATE_TO_HANDLER}
Outgoing: complete_job/fail_job --- {job_status}
"""

from .base_handler import BaseHandler
from .extract_memories import ExtractMemoriesHandler
from .promote_memories import PromoteMemoriesHandler
from .summarize_chat import SummarizeChatHandler

__all__ = [
    "BaseHandler",
    "ExtractMemoriesHandler",
    "PromoteMemoriesHandler",
    "SummarizeChatHandler",
]
