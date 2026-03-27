import asyncio
import logging
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, List

from monitoring import get_logger
from application.indexing.aether_rag_service import AetherRagService
from config.settings import get_settings

logger = get_logger(__name__)

class IncrementalSyncManager:
    """Manages periodic incremental syncing of fast event logs (Browser, Email, FileSystem) to Aether-RAG."""
    
    def __init__(self, aether_rag_manager: AetherRagService):
        self.aether_rag_manager = aether_rag_manager
        self.settings = get_settings()
        self.app_root = self.settings.app_root
        
        # Load configs to know interval times and retention
        from services.daemons.browser.config import BrowserDaemonConfig
        from services.daemons.email.config import EmailDaemonConfig
        from services.daemons.query_generation.config import QueryGenerationDaemonConfig
        
        self.browser_config = BrowserDaemonConfig.from_settings()
        self.email_config = EmailDaemonConfig.from_settings()
        self.qgen_config = QueryGenerationDaemonConfig.from_settings()
        
        # Initialize DBs for reading
        from services.daemons.browser.db import BrowserDB
        from services.daemons.email.db import EmailDB
        from services.daemons.filesystem.db import FileSystemDB
        from services.daemons.filesystem.config import FileSystemDaemonConfig
        from services.daemons.query_generation.db import QueryGenerationDB
        
        self.browser_db = BrowserDB(self.browser_config.db_path)
        self.email_db = EmailDB(self.email_config.db_path)
        self.qgen_db = QueryGenerationDB(self.qgen_config.db_path)
        
        self.fs_config = FileSystemDaemonConfig.from_settings()
        self.fs_db = FileSystemDB(self.fs_config.db_path)
        
        self.last_sync_times = {
            'browser': datetime.now(timezone.utc),
            'email': datetime.now(timezone.utc),
            'filesystem': datetime.now(timezone.utc),
            'query_gen': datetime.now(timezone.utc),
        }
        
    async def process_syncs(self):
        """Check all sources and sync if their interval has passed."""
        now = datetime.now(timezone.utc)
        
        # Browser sync
        if (now - self.last_sync_times['browser']).total_seconds() >= self.browser_config.bm25_index_interval_seconds:
            await self._sync_browser_logs()
            self.last_sync_times['browser'] = now
            
        # Email sync
        if (now - self.last_sync_times['email']).total_seconds() >= self.email_config.bm25_index_interval_seconds:
            await self._sync_email_logs()
            self.last_sync_times['email'] = now
            
        # FileSystem sync
        if (now - self.last_sync_times['filesystem']).total_seconds() >= self.fs_config.bm25_index_interval_seconds:
            await self._sync_filesystem_logs()
            self.last_sync_times['filesystem'] = now
            
        # Query Generation sync
        if (now - self.last_sync_times['query_gen']).total_seconds() >= self.qgen_config.bm25_index_interval_seconds:
            await self._sync_query_gen()
            self.last_sync_times['query_gen'] = now
            
    async def _sync_query_gen(self):
        try:
            logs = self.qgen_db.get_unindexed_queries(limit=1000)
            if not logs:
                return
            
            chunks = []
            for log in logs:
                chunks.append({
                    'text': log['query'],
                    'metadata': {
                        'source': 'query_gen',
                        'doc_id': str(log['query_id']),
                        'generation_method': log.get('generation_method', ''),
                        'timestamp': log.get('timestamp', ''),
                        'context_doc_ids': json.dumps(log.get('context_doc_ids', []))
                    }
                })
                
            index_dir = self.app_root / "data" / "aether_rag_sources" / "query_gen"
            index_name = "query_generation_events"
            index_mode = "bm25"
            
            indexed_count = await self.aether_rag_manager.build_index(
                index_directory=index_dir,
                index_name=index_name,
                chunks=chunks,
                index_mode=index_mode,
                incremental=True
            )
            
            if indexed_count > 0:
                query_ids = [log['id'] for log in logs[:indexed_count]]
                self.qgen_db.mark_as_indexed(query_ids)
                logger.info(f"✅ Incremental Sync: {indexed_count} generated queries indexed via AetherRagService")
        except Exception as e:
            logger.error(f"Failed to incrementally sync generated queries: {e}", exc_info=True)
            
    async def _sync_filesystem_logs(self):
        try:
            logs = self.fs_db.get_unindexed_logs(limit=1000)
            if not logs:
                return
            
            chunks = []
            for log in logs:
                text = f"{log.get('action', '')} {log.get('file_path', '')} {log.get('file_name', '')} {log.get('location_name', '')}".strip()
                chunks.append({
                    'text': text,
                    'metadata': {
                        'source': 'filesystem_log',
                        'doc_id': str(log['id']),
                        'action': log.get('action', ''),
                        'file_path': log.get('file_path', ''),
                        'file_name': log.get('file_name', ''),
                        'timestamp': log.get('timestamp', ''),
                        'location_name': log.get('location_name', '')
                    }
                })
                
            index_dir = self.app_root / "data" / "aether_rag_sources" / "filesystem"
            index_name = "filesystem_events"
            index_mode = "bm25"
            
            indexed_count = await self.aether_rag_manager.build_index(
                index_directory=index_dir,
                index_name=index_name,
                chunks=chunks,
                index_mode=index_mode,
                incremental=True
            )
            
            if indexed_count > 0:
                log_ids = [log['id'] for log in logs[:indexed_count]]
                self.fs_db.mark_as_indexed(log_ids)
                logger.info(f"✅ Incremental Sync: {indexed_count} filesystem logs indexed via AetherRagService")
        except Exception as e:
            logger.error(f"Failed to incrementally sync filesystem logs: {e}", exc_info=True)
        
    async def _sync_browser_logs(self):
        try:
            logs = self.browser_db.get_unindexed_logs(limit=1000)
            if not logs:
                return
            
            chunks = []
            for log in logs:
                search_q = log.get('search_query') or ''
                text = f"{log.get('url', '')} {log.get('title', '')} {search_q}".strip()
                chunks.append({
                    'text': text,
                    'metadata': {
                        'source': 'browser_history',
                        'doc_id': str(log['id']),
                        'url': log.get('url', ''),
                        'title': log.get('title', ''),
                        'timestamp': log.get('timestamp', ''),
                        'visit_count': log.get('visit_count', 1),
                        'typed_count': log.get('typed_count', 0),
                        'profile': log.get('profile', '')
                    }
                })
                
            index_dir = self.app_root / "data" / "aether_rag_sources" / "browser"
            index_name = self.settings.integrations.aether_rag_sources.browser_history.default_index_name
            index_mode = self.settings.integrations.aether_rag_sources.browser_history.index_mode
            
            indexed_count = await self.aether_rag_manager.build_index(
                index_directory=index_dir,
                index_name=index_name,
                chunks=chunks,
                index_mode=index_mode,
                incremental=True
            )
            
            if indexed_count > 0:
                log_ids = [log['id'] for log in logs[:indexed_count]]
                self.browser_db.mark_as_indexed(log_ids)
                logger.info(f"✅ Incremental Sync: {indexed_count} browser logs indexed")
                
        except Exception as e:
            logger.error(f"Failed to incrementally sync browser logs: {e}", exc_info=True)

    async def _sync_email_logs(self):
        try:
            logs = self.email_db.get_unindexed_logs(limit=1000)
            if not logs:
                return
                
            chunks = []
            for log in logs:
                text = f"Subject: {log.get('subject', '')}\nSender: {log.get('sender', '')}\n\n{log.get('body_preview', '')}".strip()
                chunks.append({
                    'text': text,
                    'metadata': {
                        'source': 'email',
                        'doc_id': str(log['id']),
                        'subject': log.get('subject', ''),
                        'sender': log.get('sender', ''),
                        'timestamp': log.get('timestamp', '')
                    }
                })
                
            index_dir = self.app_root / "data" / "aether_rag_sources" / "email"
            index_name = self.settings.integrations.aether_rag_sources.email.default_index_name
            index_mode = self.settings.integrations.aether_rag_sources.email.index_mode
            
            indexed_count = await self.aether_rag_manager.build_index(
                index_directory=index_dir,
                index_name=index_name,
                chunks=chunks,
                index_mode=index_mode,
                incremental=True
            )
            
            if indexed_count > 0:
                log_ids = [log['id'] for log in logs[:indexed_count]]
                self.email_db.mark_as_indexed(log_ids)
                logger.info(f"✅ Incremental Sync: {indexed_count} email logs indexed")
                
        except Exception as e:
            logger.error(f"Failed to incrementally sync email logs: {e}", exc_info=True)
