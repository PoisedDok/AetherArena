"""
@.architecture
Incoming: services/file_indexing/daemon.py, IndexingServiceConfig --- {config dataclass}
Processing: create Supabase client instance --- {1 job: JOB_INITIALIZE_COMPONENT}
Outgoing: services/file_indexing/daemon.py --- {SupabaseClient instance}
"""

import sys
from pathlib import Path

# Add parent directory to path to import from aether-backend
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from data.database.clients.supabase import SupabaseClient
from services.daemons.file_indexing.config import IndexingServiceConfig


def create_supabase_client(config: IndexingServiceConfig) -> SupabaseClient:
    """
    Create Supabase client for standalone service.
    
    Args:
        config: Service configuration
        
    Returns:
        SupabaseClient instance
        
    Raises:
        ValueError: If configuration is invalid
    """
    if not config.supabase_url or not config.supabase_key:
        raise ValueError("Supabase URL and key are required")
    
    return SupabaseClient(
        url=config.supabase_url,
        key=config.supabase_key
    )

