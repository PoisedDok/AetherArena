"""
Indexing Service

Orchestrates AetherRag index discovery and searching.
"""
import json
import time
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional

import aiofiles

from core.domain.repository_interfaces import IFileIndexingRepository
from config.settings import Settings
from application.services.source_indexing_service import SourceIndexingService
from monitoring import get_logger

# Import managers at module level to avoid inline import overhead
from application.indexing.aether_rag_service import AetherRagService

logger = get_logger(__name__)

class IndexingError(Exception):
    pass

class IndexNotFoundError(IndexingError):
    pass

class IndexDisabledError(IndexingError):
    pass

class IndexService:
    def __init__(self, settings: Settings, repository: IFileIndexingRepository, search_indexes_repo=None):
        self.settings = settings
        self.repository = repository
        self.search_indexes_repo = search_indexes_repo

    async def _read_json_file_async(self, file_path: Path) -> dict:
        try:
            async with aiofiles.open(file_path, mode='r') as f:
                content = await f.read()
                return json.loads(content)
        except Exception as e:
            logger.warning(f"Could not read json file {file_path}: {e}")
            return {}

    async def discover_agent_indexes(self) -> List[Dict[str, Any]]:
        indexes = []
        index_dir = self.settings.app_root / "data" / "aether_rag_indexes"
        
        if not index_dir.exists():
            return indexes
        
        for meta_file in index_dir.glob("agent_*_index.aether_rag.meta.json"):
            index_name = meta_file.name.replace(".aether_rag.meta.json", "")
            agent_key = index_name.replace("agent_", "").replace("_index", "")
            display_name = f"{agent_key.replace('_', ' ').title()} Agent"
            description = f"{display_name} outputs"
            
            if meta_file.exists():
                try:
                    stat = await asyncio.to_thread(meta_file.stat)
                    meta = await self._read_json_file_async(meta_file)
                    
                    chunk_count = len(meta.get('passage_ids', []))
                    is_bm25_only = meta.get('bm25_only', False)
                    is_bm25_enabled = meta.get('bm25_enabled', False)
                    
                    supported_modes = ["semantic"]
                    metadata = {}
                    if is_bm25_only:
                        supported_modes = ["bm25"]
                        metadata["bm25_only"] = True
                    elif is_bm25_enabled:
                        supported_modes = ["semantic", "bm25", "hybrid"]
                        metadata["bm25_enabled"] = True
                    
                    indexes.append({
                        "index_name": index_name,
                        "index_type": "agent_output",
                        "display_name": display_name,
                        "description": description,
                        "chunk_count": chunk_count,
                        "index_size_bytes": stat.st_size,
                        "last_updated": str(stat.st_mtime),
                        "is_searchable": True,
                        "index_path": str(meta_file.parent),
                        "supported_modes": supported_modes,
                        "metadata": metadata
                    })
                except Exception as e:
                    logger.warning("Could not read agent index %s: %s", index_name, e)
        
        return indexes

    async def discover_file_indexes(self) -> List[Dict[str, Any]]:
        indexes = []
        try:
            locations = await self.repository.get_all_locations(enabled_only=False)
            
            for location in locations:
                index_name = location['index_name']
                index_dir = Path(location['index_directory'])
                meta_file = index_dir / f"{index_name}.aether_rag.meta.json"
                
                supported_modes = ["semantic"]
                metadata = location.get('metadata', {}) or {}
                if meta_file.exists():
                    meta = await self._read_json_file_async(meta_file)
                    if meta.get('bm25_only', False):
                        supported_modes = ["bm25"]
                        metadata["bm25_only"] = True
                    elif meta.get('bm25_enabled', False):
                        supported_modes = ["semantic", "bm25", "hybrid"]
                        metadata["bm25_enabled"] = True

                indexes.append({
                    "index_name": index_name,
                    "index_type": "file_location",
                    "display_name": location['location_name'],
                    "description": f"Files from {location['root_path']}",
                    "chunk_count": location.get('chunk_count'),
                    "index_size_bytes": location.get('index_size_bytes'),
                    "last_updated": location.get('last_scan_at'),
                    "is_searchable": location['enabled'],
                    "index_path": location['index_directory'],
                    "supported_modes": supported_modes,
                    "metadata": metadata
                })
        except Exception as e:
            logger.error("Failed to discover file indexes: %s", e, exc_info=True)
        return indexes

    async def _get_aether_rag_index_size(self, index_directory: Path, index_name: str, quick: bool = False) -> Optional[int]:
        def _get_size():
            total = 0
            found = False
            index_file = index_directory / f"{index_name}.aether_rag"
            if index_file.exists():
                total += index_file.stat().st_size
                found = True
            
            if not quick:
                bm25_dir = index_directory / f"{index_name}.aether_rag.bm25"
                if bm25_dir.exists() and bm25_dir.is_dir():
                    try:
                        for f in bm25_dir.rglob("*"):
                            if f.is_file():
                                total += f.stat().st_size
                    except Exception:
                        pass
                    found = True
                    
            passages = index_directory / f"{index_name}.aether_rag.passages.jsonl"
            if passages.exists():
                total += passages.stat().st_size
                found = True
            return total if found else None
            
        return await asyncio.to_thread(_get_size)

    async def discover_source_indexes(self, quick: bool = False) -> List[Dict[str, Any]]:
        indexes = []
        service = SourceIndexingService(self.settings, self.search_indexes_repo)
        entries = await asyncio.to_thread(service.list_indexes)
        for entry in entries:
            index_dir = Path(entry.get("index_directory", ""))
            index_name = entry.get("index_name", "")
            if not index_name or not index_dir.exists():
                continue
                
            meta_file = index_dir / f"{index_name}.aether_rag.meta.json"
            supported_modes = ["semantic"]
            metadata = entry.get("metadata", {}) or {}
            
            # Check registry metadata first (Custom Indexes store index_mode here)
            reg_mode = metadata.get("index_mode")
            if reg_mode == "combined":
                supported_modes = ["semantic", "bm25", "hybrid"]
            elif reg_mode == "bm25":
                supported_modes = ["bm25"]
            elif reg_mode == "semantic":
                supported_modes = ["semantic"]
            
            if meta_file.exists():
                meta = await self._read_json_file_async(meta_file)
                if meta.get('bm25_only', False):
                    supported_modes = ["bm25"]
                    metadata["bm25_only"] = True
                elif meta.get('bm25_enabled', False):
                    supported_modes = ["semantic", "bm25", "hybrid"]
                    metadata["bm25_enabled"] = True

            index_size = await self._get_aether_rag_index_size(index_dir, index_name, quick=quick)
            indexes.append({
                "index_name": index_name,
                "index_type": "source",
                "display_name": entry.get("display_name") or index_name,
                "description": entry.get("description"),
                "chunk_count": entry.get("chunk_count"),
                "index_size_bytes": index_size,
                "last_updated": entry.get("updated_at") or entry.get("created_at"),
                "is_searchable": True,
                "index_path": str(index_dir),
                "supported_modes": supported_modes,
                "source_type": entry.get("source_type"),
                "metadata": metadata,
            })
        
        daemon_indexes_dir = self.settings.app_root / "data" / "indexes"
        if daemon_indexes_dir.exists():
            for index_path in daemon_indexes_dir.iterdir():
                if index_path.is_dir() and (index_path / "data.properties").exists():
                    meta_files = list(index_path.glob("*.aether_rag.meta.json"))
                    if meta_files:
                        meta_file = meta_files[0]
                        meta = await self._read_json_file_async(meta_file)
                        index_name = meta.get("index_name", index_path.name)
                        
                        if not any(idx["index_name"] == index_name for idx in indexes):
                            def _get_daemon_size(p: Path):
                                total = 0
                                try:
                                    for f in p.rglob("*"):
                                        if f.is_file():
                                            total += f.stat().st_size
                                except Exception:
                                    pass
                                return total
                                
                            index_size = await asyncio.to_thread(_get_daemon_size, index_path)
                            
                            supported_modes = ["semantic"]
                            if meta.get('bm25_only', False):
                                supported_modes = ["bm25"]
                            elif meta.get('bm25_enabled', False):
                                supported_modes = ["semantic", "bm25", "hybrid"]
                            
                            metadata = meta.copy()
                            metadata["pyterrier_index"] = True
                            metadata["daemon_managed"] = True
                            
                            indexes.append({
                                "index_name": index_name,
                                "index_type": "source",
                                "display_name": meta.get("display_name", index_name),
                                "description": meta.get("description", ""),
                                "chunk_count": meta.get("chunk_count", None),
                                "index_size_bytes": index_size if index_size > 0 else None,
                                "last_updated": meta.get("last_updated", None),
                                "is_searchable": True,
                                "index_path": str(index_path),
                                "supported_modes": supported_modes,
                                "source_type": meta.get("source_type", index_name),
                                "metadata": metadata,
                            })

        # Also discover dynamically created AetherRAG daemon indices (like filesystem_events)
        rag_sources_dir = self.settings.app_root / "data" / "aether_rag_sources"
        if rag_sources_dir.exists():
            for source_dir in rag_sources_dir.iterdir():
                if source_dir.is_dir():
                    for meta_file in source_dir.glob("*.aether_rag.meta.json"):
                        if "__shard__" in meta_file.name:
                            continue
                            
                        index_name = meta_file.name.replace(".aether_rag.meta.json", "")
                        if any(idx["index_name"] == index_name for idx in indexes):
                            continue
                            
                        meta = await self._read_json_file_async(meta_file)
                        supported_modes = ["semantic"]
                        if meta.get('bm25_only', False):
                            supported_modes = ["bm25"]
                        elif meta.get('bm25_enabled', False):
                            supported_modes = ["semantic", "bm25", "hybrid"]
                            
                        index_dir = source_dir
                        index_size = await self._get_aether_rag_index_size(index_dir, index_name, quick=quick)
                        
                        metadata = meta.copy()
                        metadata["daemon_managed"] = True
                        
                        indexes.append({
                            "index_name": index_name,
                            "index_type": "source",
                            "display_name": index_name.replace("_", " ").title(),
                            "description": "Auto-generated daemon index",
                            "chunk_count": meta.get("chunk_count", None),
                            "index_size_bytes": index_size,
                            "last_updated": None,
                            "is_searchable": True,
                            "index_path": str(index_dir),
                            "supported_modes": supported_modes,
                            "source_type": source_dir.name,
                            "metadata": metadata,
                        })
        
        return indexes

    async def list_all_indexes(self, quick: bool = False) -> Dict[str, Any]:
        agent_indexes, file_indexes, source_indexes = await asyncio.gather(
            self.discover_agent_indexes(),
            self.discover_file_indexes(),
            self.discover_source_indexes(quick=quick)
        )
        
        all_indexes = agent_indexes + file_indexes + source_indexes
        
        by_type = {
            "agent_output": len(agent_indexes),
            "file_location": len(file_indexes),
            "source": len(source_indexes),
        }
        
        return {
            "indexes": all_indexes,
            "total_count": len(all_indexes),
            "by_type": by_type
        }

    async def search_index(
        self,
        index_name: str,
        query: str,
        top_k: int = 10,
        min_score: float = 0.0,
        mode: str = "bm25",
        _index_info: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        start_time = time.time()
        
        if min_score is None:
            min_score = 0.0
            
        is_agent_index = index_name.startswith("agent_")
        
        if _index_info is None:
            # Need to find the index info dynamically if not provided
            all_indexes = await self.list_all_indexes(quick=True)
            logger.info(f"Available indexes: {[idx['index_name'] for idx in all_indexes['indexes']]}")
            _index_info = next((idx for idx in all_indexes["indexes"] if idx["index_name"] == index_name), None)

        if not _index_info:
            raise IndexNotFoundError(f"Index '{index_name}' not found")
            
        if not _index_info.get("is_searchable", True):
            raise IndexDisabledError(f"Index '{index_name}' is disabled")

        supported_modes = _index_info.get("supported_modes") or []
        if supported_modes:
            if mode == "hybrid":
                if "hybrid" not in supported_modes and not ("semantic" in supported_modes and "bm25" in supported_modes):
                    raise IndexingError(f"Index '{index_name}' does not support hybrid mode. Supported: {supported_modes}")
            elif mode not in supported_modes:
                raise IndexingError(f"Index '{index_name}' does not support '{mode}' mode. Supported: {supported_modes}")

        manager = AetherRagService(
            embedding_model=self.settings.embedding_service.model,
            api_base=self.settings.embedding_service.openai_base_url,
        )
        
        if is_agent_index:
            index_path = self.settings.app_root / "data" / "aether_rag_indexes"
            index_type = "agent_output"
        else:
            index_path = _index_info.get("index_path")
            if not index_path:
                raise IndexNotFoundError(f"Index path for '{index_name}' is invalid")
            index_path = Path(index_path)
            index_type = _index_info.get("index_type", "source")

        search_results = await manager.search(
            index_directory=index_path,
            index_name=index_name,
            query=query,
            top_k=top_k,
            mode=mode
        )

        results = []
        for result in search_results:
            if isinstance(result, dict):
                score = result.get('score', 0.0)
                text = result.get('text', '')
                metadata = result.get('metadata', {})
            else:
                score = getattr(result, 'score', 0.0)
                text = getattr(result, 'text', str(result))
                metadata = getattr(result, 'metadata', {})

            # For hybrid mode, RRF scores are naturally very small (e.g., < 0.02)
            # We bypass the min_score filter for hybrid mode to prevent dropping all results
            effective_min = 0.0 if mode == "hybrid" else min_score

            if score >= effective_min:
                results.append({
                    "index_name": index_name,
                    "index_type": index_type,
                    "score": float(score),
                    "text": text,
                    "metadata": metadata
                })
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        return {
            "results": results,
            "total_found": len(results),
            "indexes_searched": [index_name],
            "search_duration_ms": duration_ms
        }

    async def search_multiple_indexes(
        self,
        index_names: List[str],
        query: str,
        top_k: int = 10,
        min_score: float = 0.0,
        mode: str = "bm25"
    ) -> Dict[str, Any]:
        start_time = time.time()
        
        # Discover all indexes ONCE
        all_indexes_info = await self.list_all_indexes(quick=True)
        all_indexes_map = {idx["index_name"]: idx for idx in all_indexes_info["indexes"]}
        
        search_tasks = []
        for index_name in index_names:
            index_info = all_indexes_map.get(index_name)
            search_tasks.append(
                self.search_index(
                    index_name=index_name,
                    query=query,
                    top_k=top_k,
                    min_score=min_score,
                    mode=mode,
                    _index_info=index_info
                )
            )
        
        search_responses = await asyncio.gather(*search_tasks, return_exceptions=True)
        
        all_results = []
        successful_indexes = []
        
        for idx, response in enumerate(search_responses):
            if isinstance(response, Exception):
                logger.warning("Search failed for %s: %s", index_names[idx], response)
                continue
            
            all_results.extend(response["results"])
            successful_indexes.append(index_names[idx])
        
        all_results.sort(key=lambda r: r["score"], reverse=True)
        all_results = all_results[:top_k]
        
        duration_ms = int((time.time() - start_time) * 1000)
        
        return {
            "results": all_results,
            "total_found": len(all_results),
            "indexes_searched": successful_indexes,
            "search_duration_ms": duration_ms
        }

    def dispose(self) -> None:
        """Clean up resources held by this service."""
        from application.indexing.aether_rag_service import dispose_aether_rag_service
        dispose_aether_rag_service()
