"""
@.architecture
Incoming: services/file_indexing/daemon.py, Environment variables --- {dataclass constructor, env vars}
Processing: load and validate service configuration --- {1 job: JOB_LOAD_CONFIG}
Outgoing: services/file_indexing/daemon.py --- {IndexingServiceConfig dataclass}
"""

import os
from dataclasses import dataclass
from typing import Optional
from pathlib import Path


@dataclass
class IndexingServiceConfig:
    """Configuration for file indexing service.
    
    Embedding config read from central config (models.toml [EMBEDDINGS]) via settings.py.
    Primary: Perplexica ONNX (Docker mesh, always available, lightweight).
    Fallback defaults match Perplexica so daemon works even without central config.
    """
    
    # Supabase connection
    supabase_url: str
    supabase_key: str
    
    # AETHER_RAG configuration — embeddings via OpenAI-compatible API
    # Defaults: Perplexica ONNX (primary embedding provider per central config)
    # api_base is the OpenAI SDK base URL (SDK appends /embeddings automatically)
    aether_rag_embedding_model: str = "Xenova/bge-small-en-v1.5"
    aether_rag_embedding_api_base: str = "http://localhost:3000/api"
    aether_rag_embedding_api_key: str = "not-needed"
    aether_rag_enable_bm25: bool = True
    
    # Service configuration
    heartbeat_interval_seconds: int = 30
    scan_check_interval_seconds: int = 60
    max_concurrent_scans: int = 1
    
    # Logging
    log_level: str = "INFO"
    log_file: Optional[Path] = None
    
    @classmethod
    def from_env(cls) -> 'IndexingServiceConfig':
        """Load configuration from environment variables → central config → hardcoded defaults.
        
        Priority: env vars > central config (models.toml via settings.py) > dataclass defaults.
        """
        supabase_url = os.getenv("SUPABASE_URL", "")
        supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
        embedding_model = os.getenv("EMBEDDING_SERVICE_MODEL", "")
        embedding_api_base = os.getenv("EMBEDDING_SERVICE_BASE_URL", "")
        embedding_api_key = os.getenv("EMBEDDING_SERVICE_API_KEY", "")
        
        # Fallback to central config (models.toml) for any unset values
        try:
            from config.settings import get_settings
            backend_settings = get_settings()
            supabase_url = supabase_url or backend_settings.supabase.url
            supabase_key = supabase_key or backend_settings.supabase.service_role_key
            # Read embedding config from central embedding_service (Perplexica ONNX)
            embedding_model = embedding_model or backend_settings.embedding_service.model
            embedding_api_base = embedding_api_base or backend_settings.embedding_service.openai_base_url
            # Embedding service is local (no API key needed)
            embedding_api_key = embedding_api_key or "not-needed"
        except Exception:
            # Central config unavailable (standalone daemon mode) — use dataclass defaults
            pass
        
        return cls(
            supabase_url=supabase_url,
            supabase_key=supabase_key,
            aether_rag_embedding_model=embedding_model or "Xenova/bge-small-en-v1.5",
            aether_rag_embedding_api_base=embedding_api_base or "http://localhost:3000/api",
            aether_rag_embedding_api_key=embedding_api_key or "not-needed",
            aether_rag_enable_bm25=os.getenv("FI_ENABLE_BM25", "true").lower() == "true",
            heartbeat_interval_seconds=int(os.getenv("FI_HEARTBEAT_INTERVAL", "30")),
            scan_check_interval_seconds=int(os.getenv("FI_SCAN_INTERVAL", "60")),
            max_concurrent_scans=int(os.getenv("FI_MAX_CONCURRENT", "1")),
            log_level=os.getenv("FI_LOG_LEVEL", "INFO"),
            log_file=Path(os.getenv("FI_LOG_FILE")) if os.getenv("FI_LOG_FILE") else None
        )
    
    def validate(self) -> None:
        """Validate configuration."""
        if not self.supabase_url:
            raise ValueError("SUPABASE_URL is required")
        if not self.supabase_key:
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required")

