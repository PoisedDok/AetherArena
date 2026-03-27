"""
Daemon Service

Orchestrates daemon configuration, health, status, and logs fetching.
"""

from core.domain.repository_interfaces import IDaemonLogsRepository, IFileIndexingRepository
from typing import List, Optional, Dict, Any
from pathlib import Path
import json as _json

from config.settings import Settings
from data.database.persistence_gateway import SupabasePersistenceGateway
from monitoring import get_logger

logger = get_logger(__name__)

class DaemonService:
    def __init__(
        self,
        settings: Settings,
        file_indexing_repo: IFileIndexingRepository,
        daemon_logs_repo: IDaemonLogsRepository,
        database: SupabasePersistenceGateway
    ):
        self._settings = settings
        self._file_indexing_repo = file_indexing_repo
        self._daemon_logs_repo = daemon_logs_repo
        self._database = database

    async def get_service_health(self) -> Optional[Dict[str, Any]]:
        return await self._file_indexing_repo.get_service_health()
        
    async def get_daemon_config(self) -> Dict[str, Any]:
        """Get all proactive daemon configurations."""
        # Get file_indexing config from DB
        file_indexing_config = await self._file_indexing_repo.get_daemon_config() or {}
        
        # Get defaults from config/settings.py
        proactive = self._settings.proactive
        default_embedding_model = (
            getattr(getattr(self._settings, "embedding_service", None), "model", None)
            or getattr(getattr(self._settings, "embeddings", None), "model", None)
            or "Xenova/bge-small-en-v1.5"
        )
        
        # Load user preferences for other daemons (priority over defaults)
        try:
            user_prefs = await self._database.select(
                "user_preferences",
                filters={"user_id": "default_user"},
                admin=True
            )
            if not isinstance(user_prefs, list):
                user_prefs = []
        except Exception as e:
            logger.warning("Failed to load user preferences: %s", e)
            user_prefs = []
            
        # Build preference map
        pref_map = {}
        for pref in user_prefs:
            pref_key = pref.get("preference_key", "")
            if pref_key.startswith("daemon_"):
                daemon_name = pref_key.replace("daemon_", "")
                pref_map[daemon_name] = pref.get("preference_value", {})
                
        browser_config = pref_map.get("browser", {})
        email_config = pref_map.get("email", {})
        filesystem_config = pref_map.get("filesystem", {})
        query_generation_config = pref_map.get("query_generation", {})
        
        return {
            "browser": {
                "enabled": browser_config.get("enabled", proactive.browser.enabled),
                "scan_interval_seconds": browser_config.get("scan_interval_seconds", proactive.browser.scan_interval_seconds),
                "retention_days": browser_config.get("retention_days", proactive.browser.retention_days),
                "bm25_index_interval_seconds": browser_config.get("bm25_index_interval_seconds", proactive.browser.bm25_index_interval_seconds),
                "browser": browser_config.get("browser", proactive.browser.browser),
                "excluded_profiles": browser_config.get("excluded_profiles", proactive.browser.excluded_profiles),
                "log_level": browser_config.get("log_level", proactive.browser.log_level)
            },
            "email": {
                "enabled": email_config.get("enabled", proactive.email.enabled),
                "scan_interval_seconds": email_config.get("scan_interval_seconds", proactive.email.scan_interval_seconds),
                "retention_days": email_config.get("retention_days", proactive.email.retention_days),
                "max_emails_per_scan": email_config.get("max_emails_per_scan", proactive.email.max_emails_per_scan),
                "log_level": email_config.get("log_level", proactive.email.log_level)
            },
            "filesystem": {
                "enabled": filesystem_config.get("enabled", proactive.filesystem.enabled),
                "watch_locations": filesystem_config.get("watch_locations", proactive.filesystem.watch_locations),
                "debounce_seconds": filesystem_config.get("debounce_seconds", proactive.filesystem.debounce_seconds),
                "retention_days": filesystem_config.get("retention_days", proactive.filesystem.retention_days),
                "log_level": filesystem_config.get("log_level", proactive.filesystem.log_level)
            },
            "file_indexing": {
                "enabled": True,
                "aether_rag_embedding_model": file_indexing_config.get('aether_rag_embedding_model', default_embedding_model),
                "heartbeat_interval_seconds": file_indexing_config.get('heartbeat_interval_seconds', 45),
                "scan_check_interval_seconds": file_indexing_config.get('scan_check_interval_seconds', 60),
                "max_concurrent_scans": file_indexing_config.get('max_concurrent_scans', 1),
                "log_level": file_indexing_config.get('log_level', 'DEBUG')
            },
            "query_generation": {
                "enabled": query_generation_config.get("enabled", proactive.query_generation.enabled),
                "check_interval_seconds": query_generation_config.get("check_interval_seconds", proactive.query_generation.check_interval_seconds),
                "context_size": query_generation_config.get("context_size", proactive.query_generation.context_size),
                "max_query_terms": query_generation_config.get("max_query_terms", proactive.query_generation.max_query_terms),
                "llm_model": query_generation_config.get("llm_model", proactive.query_generation.llm_model or self._settings.llm.model),
                "log_level": query_generation_config.get("log_level", proactive.query_generation.log_level)
            }
        }

    async def update_daemon_config(self, config_dict: Dict[str, Any]) -> Dict[str, Any]:
        import tempfile as _tempfile
        
        updated_daemons = []
        
        # File indexing
        if config_dict.get("file_indexing") is not None:
            fi_dict = config_dict["file_indexing"]
            if fi_dict:
                await self._file_indexing_repo.update_daemon_config(fi_dict)
                updated_daemons.append("file_indexing")
                logger.info("File indexing daemon config updated: %s", list(fi_dict.keys()))

        daemon_sections = {
            "browser": config_dict.get("browser"),
            "email": config_dict.get("email"),
            "filesystem": config_dict.get("filesystem"),
            "query_generation": config_dict.get("query_generation"),
        }
        
        for daemon_name, section in daemon_sections.items():
            if not section:
                continue
                
            # Store in user_preferences table
            await self._database.upsert(
                "user_preferences",
                {
                    "user_id": "default_user",
                    "preference_key": f"daemon_{daemon_name}",
                    "preference_value": section
                },
                admin=True
            )
            
            # Write local override file
            try:
                override_dir = self._settings.app_root / "data" / "daemons" / daemon_name
                override_dir.mkdir(parents=True, exist_ok=True)
                override_path = override_dir / "config_override.json"
                
                with _tempfile.NamedTemporaryFile('w', dir=str(override_dir), delete=False) as tf:
                    _json.dump(section, tf, indent=2)
                    tf.flush()
                    tmp_path = Path(tf.name)
                
                tmp_path.replace(override_path)
                logger.info("Wrote %s override file: %s", daemon_name, override_path)
            except Exception as override_err:
                logger.error("Failed to write %s override file: %s", daemon_name, override_err, exc_info=True)
                raise ValueError(f"Failed to persist {daemon_name} override config") from override_err
                
            updated_daemons.append(daemon_name)
            logger.info("%s daemon config updated: %s", daemon_name, list(section.keys()))
            
        if not updated_daemons:
            raise ValueError("No valid daemon configurations provided")
            
        # Reload running daemon-manager
        reload_attempted = False
        reload_success = False
        reload_skipped_onboarding_mode = False
        try:
            from services.daemons.daemon_control import (
                is_onboarding_setup_mode,
                is_daemon_manager_running,
                reload_daemon_manager,
            )

            if is_onboarding_setup_mode():
                reload_skipped_onboarding_mode = True
                logger.info("Skipping daemon manager reload during onboarding setup mode")
            elif is_daemon_manager_running():
                reload_attempted = True
                reload_success = reload_daemon_manager()
        except Exception as err:
            logger.warning("Unable to reload daemon manager after config update: %s", err)
            
        if reload_skipped_onboarding_mode:
            message = f"Configuration updated for {len(updated_daemons)} daemon(s). Reload skipped during onboarding setup mode; changes apply after restart."
        elif reload_attempted and reload_success:
            message = f"Configuration updated for {len(updated_daemons)} daemon(s). Daemon manager reloaded."
        elif reload_attempted:
            message = f"Configuration updated for {len(updated_daemons)} daemon(s). Daemon manager reload failed; changes apply on next restart."
        else:
            message = f"Configuration updated for {len(updated_daemons)} daemon(s). Daemon manager not running; changes apply when it starts."
            
        return {
            "success": True,
            "message": message,
            "updated_daemons": updated_daemons
        }

    async def restart_daemon(self, pid: int) -> None:
        """Restart a daemon process by its PID using ProcessGateway."""
        from core.system.process_gateway import ProcessGateway
        gateway = ProcessGateway()
        gateway.restart_process(pid)

    async def stop_daemon(self, daemon_name: str) -> None:
        """Stop a daemon by name using ProcessGateway."""
        from core.system.process_gateway import ProcessGateway
        gateway = ProcessGateway()
        gateway.stop_daemon(daemon_name)

    async def start_daemon(self, daemon_name: str, backend_root, executable_path, is_frozen: bool) -> None:
        """Start a daemon by name using ProcessGateway."""
        from core.system.process_gateway import ProcessGateway
        gateway = ProcessGateway()
        gateway.start_daemon(daemon_name, backend_root, executable_path, is_frozen)

    def get_logs(self, daemon_name: str, limit: int = 100, hours_back: Optional[int] = None, only_unindexed: bool = False) -> List[Dict[str, Any]]:
        return self._daemon_logs_repo.get_logs(
            daemon_name=daemon_name,
            limit=limit,
            hours_back=hours_back,
            only_unindexed=only_unindexed
        )

    def get_all_stats(self) -> Dict[str, Any]:
        return self._daemon_logs_repo.get_all_stats()

    async def get_generated_queries(self, hours_back: int = 24, source_daemon: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        from services.daemons.query_generation.db import QueryGenerationDB
        db_path = self._settings.app_root / "data" / "daemons" / "query_generation" / "queries.db"
        db = QueryGenerationDB(db_path)
        return db.get_recent_queries(hours_back=hours_back, source_daemon=source_daemon, limit=limit)

    async def get_query_generation_stats(self) -> Dict[str, Any]:
        from services.daemons.query_generation.db import QueryGenerationDB
        db_path = self._settings.app_root / "data" / "daemons" / "query_generation" / "queries.db"
        db = QueryGenerationDB(db_path)
        stats = db.get_stats()
        return {
            "status": "active",
            **stats,
            "db_path": str(db_path)
        }

    async def delete_daemon_data(self, daemon_name: str) -> List[str]:
        import shutil
        deleted_items = []
        
        db_path = self._settings.app_root / "data" / "daemons" / daemon_name / "logs.db"
        if daemon_name == "query_generation":
            db_path = self._settings.app_root / "data" / "daemons" / "query_generation" / "queries.db"
            
        if db_path.exists():
            db_path.unlink()
            deleted_items.append(f"Database: {db_path.name}")
            logger.info("Deleted %s database: %s", daemon_name, db_path)
            
        # Clear legacy indices
        index_map = {
            "browser": "browser_bm25",
            "email": "email_bm25",
            "filesystem": "filesystem_bm25"
        }
        
        if daemon_name in index_map:
            index_path = self._settings.app_root / "data" / "indexes" / index_map[daemon_name]
            if index_path.exists():
                shutil.rmtree(index_path)
                deleted_items.append(f"Legacy BM25 Index: {index_map[daemon_name]}")
                logger.info("Deleted %s legacy BM25 index: %s", daemon_name, index_path)
                
        # Clear new Aether-RAG indices
        aether_rag_map = {
            "browser": "browser",
            "email": "email",
            "filesystem": "filesystem",
            "query_generation": "query_gen"
        }
        
        if daemon_name in aether_rag_map:
            rag_dir = self._settings.app_root / "data" / "aether_rag_sources" / aether_rag_map[daemon_name]
            if rag_dir.exists():
                shutil.rmtree(rag_dir)
                deleted_items.append(f"Aether-RAG Index: {aether_rag_map[daemon_name]}")
                logger.info("Deleted %s Aether-RAG index directory: %s", daemon_name, rag_dir)
                
        return deleted_items

    async def delete_all_daemon_data(self) -> List[str]:
        import shutil
        deleted_items = []
        
        daemon_dirs = ["browser", "email", "filesystem", "query_generation"]
        for daemon_name in daemon_dirs:
            db_name = "queries.db" if daemon_name == "query_generation" else "logs.db"
            db_path = self._settings.app_root / "data" / "daemons" / daemon_name / db_name
            if db_path.exists():
                db_path.unlink()
                deleted_items.append(f"{daemon_name}: {db_name}")
                
        # Clear legacy indices
        indexes_path = self._settings.app_root / "data" / "indexes"
        if indexes_path.exists():
            for index_dir in indexes_path.iterdir():
                if index_dir.is_dir():
                    shutil.rmtree(index_dir)
                    deleted_items.append(f"Legacy Index: {index_dir.name}")
                    
        # Clear new Aether-RAG source indices
        rag_path = self._settings.app_root / "data" / "aether_rag_sources"
        if rag_path.exists():
            for rag_dir in rag_path.iterdir():
                if rag_dir.is_dir() and rag_dir.name in ["browser", "email", "filesystem", "query_gen"]:
                    shutil.rmtree(rag_dir)
                    deleted_items.append(f"Aether-RAG Index: {rag_dir.name}")
                    
        return deleted_items

    async def search_legacy_daemon_index(self, daemon_name: str, query: str, top_k: int = 10) -> Dict[str, Any]:
        """Legacy method for query_gen BM25 only."""
        canonical_daemon_name = "query_gen" if daemon_name == "query_generation" else daemon_name
        if canonical_daemon_name != "query_gen":
            raise ValueError(f"Daemon '{daemon_name}' has migrated to AETHER_RAG.")
            
        index_path = self._settings.app_root / "data" / "indexes" / f"{canonical_daemon_name}_bm25"
        
        if not (index_path / "data.properties").exists():
            return {
                "daemon": canonical_daemon_name,
                "requested_daemon": daemon_name,
                "query": query,
                "count": 0,
                "results": [],
                "message": "Index not yet created"
            }
            
        import pyterrier as pt
        if not pt.started():
            pt.init()
            
        index_ref = pt.IndexRef.of(str(index_path))
        bm25 = pt.BatchRetrieve(index_ref, wmodel="BM25")
        results_df = bm25.search(query)
        results = results_df.head(top_k).to_dict('records')
        
        return {
            "daemon": canonical_daemon_name,
            "requested_daemon": daemon_name,
            "query": query,
            "count": len(results),
            "results": results
        }


    def dispose(self) -> None:
        """Clean up resources held by this service."""
        pass
