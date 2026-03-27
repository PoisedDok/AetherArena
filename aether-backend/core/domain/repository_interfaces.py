from abc import ABC, abstractmethod
from typing import Any, List, Optional
from uuid import UUID

class IFileIndexingRepository(ABC):
    @abstractmethod
    async def create_location(self, payload: dict) -> dict: pass
    @abstractmethod
    async def get_location(self, location_id: UUID) -> Optional[dict]: pass
    @abstractmethod
    async def get_location_by_root_path(self, root_path: str) -> Optional[dict]: pass
    @abstractmethod
    async def get_all_locations(self, enabled_only: bool = False) -> List[dict]: pass
    @abstractmethod
    async def update_location(self, location_id: UUID, updates: dict) -> dict: pass
    @abstractmethod
    async def delete_location(self, location_id: UUID) -> None: pass
    @abstractmethod
    async def update_location_status(self, location_id: UUID, status: str, error: str = None) -> None: pass
    @abstractmethod
    async def update_location_stats(self, location_id: UUID, file_count: int, total_size: int, last_scan_time: str) -> None: pass
    @abstractmethod
    async def upsert_indexed_file(self, location_id: UUID, relative_path: str, file_metadata: dict) -> dict: pass
    @abstractmethod
    async def get_files_by_location(self, location_id: UUID) -> List[dict]: pass
    @abstractmethod
    async def filter_changed_files(self, location_id: UUID, files_metadata: List[dict]) -> List[dict]: pass
    @abstractmethod
    async def register_service(self, service_id: str, location_id: UUID, capabilities: List[str] = None) -> dict: pass
    @abstractmethod
    async def update_heartbeat(self, service_id: str) -> None: pass
    @abstractmethod
    async def update_service_status(self, service_id: str, status: str) -> None: pass
    @abstractmethod
    async def get_service_health(self) -> dict: pass
    @abstractmethod
    async def get_active_reindex_job(self, location_id: UUID) -> Optional[dict]: pass
    @abstractmethod
    async def get_daemon_config(self) -> dict: pass
    @abstractmethod
    async def update_daemon_config(self, updates: dict) -> dict: pass

class IProactiveAgentRepository(ABC):
    @abstractmethod
    async def insert_agent_run(self, agent_id: str, content: str, role: str) -> str: pass
    @abstractmethod
    async def mark_shown_to_user(self, run_id: str) -> None: pass
    @abstractmethod
    async def record_user_feedback(self, run_id: str, was_helpful: bool, feedback_text: str = None) -> None: pass
    @abstractmethod
    async def get_run_by_id(self, run_id: str) -> Optional[dict]: pass
    @abstractmethod
    async def get_latest_unseen_intervention(self, agent_id: str = None) -> Optional[dict]: pass
    @abstractmethod
    async def get_recent_runs(self, limit: int = 10, include_unseen: bool = True) -> List[dict]: pass
    @abstractmethod
    async def find_similar_runs(self, content_embedding: List[float], limit: int = 5, min_similarity: float = 0.8) -> List[dict]: pass
    @abstractmethod
    async def search_similar_runs(self, query_text: str, limit: int = 5) -> List[dict]: pass
    @abstractmethod
    async def get_feedback_stats(self, agent_id: str = None, days: int = 30) -> dict: pass
    @abstractmethod
    async def queue_batch(self, batch_type: str, items: List[dict], priority: int = 0) -> str: pass
    @abstractmethod
    async def get_pending_batches(self, batch_type: str = None, limit: int = 5) -> List[dict]: pass
    @abstractmethod
    async def mark_batch_processing(self, batch_id: str) -> None: pass
    @abstractmethod
    async def mark_batch_completed(self, batch_id: str, results: dict = None) -> None: pass
    @abstractmethod
    async def mark_batch_failed(self, batch_id: str, error_msg: str) -> None: pass
    @abstractmethod
    async def get_queue_stats(self) -> dict: pass

class IHealthRepository(ABC):
    @abstractmethod
    async def record_integration_health(self, service_name: str, is_healthy: bool, error_msg: str = None, latency_ms: int = None) -> None: pass

class IDaemonLogsRepository(ABC):
    @abstractmethod
    def get_logs(self, limit: int = 100, offset: int = 0, level: str = None, daemon: str = None, start_time: str = None, end_time: str = None, search: str = None) -> dict: pass
    @abstractmethod
    def get_all_stats(self) -> dict: pass

class ITrailRepository(ABC):
    @abstractmethod
    async def create_group(self, chat_id: UUID, title: str, status: str = "active", parent_group_id: UUID = None, position: int = 0, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def get_group(self, group_id: UUID) -> Optional[Any]: pass
    @abstractmethod
    async def get_groups_by_chat(self, chat_id: UUID) -> List[Any]: pass
    @abstractmethod
    async def update_group(self, group_id: UUID, title: str = None, status: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def create_subgroup(self, group_id: UUID, title: str, position: int = 0, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def create_subgroup_with_nodes(self, group_id: UUID, title: str, nodes: List[dict], position: int = 0, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def get_subgroup(self, subgroup_id: UUID) -> Optional[Any]: pass
    @abstractmethod
    async def get_subgroups_by_group(self, group_id: UUID) -> List[Any]: pass
    @abstractmethod
    async def update_subgroup(self, subgroup_id: UUID, title: str = None, status: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def update_subgroup_status(self, subgroup_id: UUID, status: str) -> Any: pass
    @abstractmethod
    async def get_node(self, node_id: UUID) -> Optional[Any]: pass
    @abstractmethod
    async def get_nodes_by_subgroup(self, subgroup_id: UUID) -> List[Any]: pass
    @abstractmethod
    async def update_node_status(self, node_id: UUID, status: str, result: str = None, artifact_id: UUID = None) -> Any: pass
    @abstractmethod
    async def update_node(self, node_id: UUID, title: str = None, description: str = None, status: str = None, result: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def link_artifact_to_node(self, node_id: UUID, artifact_id: UUID) -> Any: pass
    @abstractmethod
    async def get_group_hierarchy(self, group_id: UUID) -> dict: pass
    @abstractmethod
    async def get_subgroup_artifacts(self, subgroup_id: UUID) -> List[Any]: pass
    @abstractmethod
    async def get_trail_hierarchy(self, chat_id: UUID) -> List[dict]: pass

class ISetupStateRepository(ABC):
    @abstractmethod
    def get_progress(self) -> dict: pass
    @abstractmethod
    def save_progress(self, progress_data: dict) -> bool: pass
    @abstractmethod
    def get_onboarding_state(self) -> dict: pass
    @abstractmethod
    def save_onboarding_state(self, state_data: dict) -> bool: pass
    @abstractmethod
    def get_log_file_path(self) -> str: pass

class IPreferencesRepository(ABC):
    @abstractmethod
    async def get_preference(self, key: str, default: Any = None) -> Any: pass
    @abstractmethod
    async def set_preference(self, key: str, value: Any) -> None: pass
    @abstractmethod
    async def get_all_preferences(self) -> dict: pass
    @abstractmethod
    async def delete_preference(self, key: str) -> None: pass

class IChatRepository(ABC):
    @abstractmethod
    async def create_chat(self, title: str) -> Any: pass
    @abstractmethod
    async def create_chat_with_id(self, chat_id: UUID, title: str) -> Any: pass
    @abstractmethod
    async def ensure_chat_exists(self, chat_id: UUID, title: str) -> Any: pass
    @abstractmethod
    async def get_or_create_chat_by_title(self, title: str) -> Any: pass
    @abstractmethod
    async def get_chat(self, chat_id: UUID) -> Optional[Any]: pass
    @abstractmethod
    async def list_chats(self, limit: int = 50, offset: int = 0) -> List[Any]: pass
    @abstractmethod
    async def list_chats_from_view(self, limit: int = 50, offset: int = 0) -> List[dict]: pass
    @abstractmethod
    async def search_chats(self, query: str, limit: int = 20) -> List[dict]: pass
    @abstractmethod
    async def update_chat(self, chat_id: UUID, title: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def delete_chat(self, chat_id: UUID) -> None: pass
    @abstractmethod
    async def create_message(self, chat_id: UUID, role: str, content: str, message_id: str = None, parent_id: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def get_message(self, message_id: str) -> Optional[Any]: pass
    @abstractmethod
    async def get_messages(self, chat_id: UUID, limit: int = 50, offset: int = 0) -> List[Any]: pass
    @abstractmethod
    async def create_artifact(self, chat_id: UUID, type: str, content: str, filename: str = None, artifact_id: str = None, message_id: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def get_artifact(self, artifact_id: str) -> Optional[Any]: pass
    @abstractmethod
    async def get_artifacts(self, chat_id: UUID, type: str = None) -> List[Any]: pass
    @abstractmethod
    async def get_pending_artifacts(self, chat_id: UUID) -> List[Any]: pass
    @abstractmethod
    async def update_artifact_message_id(self, artifact_id: str, message_id: str) -> Any: pass
    @abstractmethod
    async def get_message_artifacts(self, message_id: str) -> List[Any]: pass
    @abstractmethod
    async def get_artifact_source(self, artifact_id: str) -> Optional[str]: pass
    @abstractmethod
    async def update_artifact(self, artifact_id: str, content: str = None, metadata: dict = None) -> Any: pass
    @abstractmethod
    async def delete_artifact(self, artifact_id: str) -> None: pass
    @abstractmethod
    async def delete_message(self, message_id: str) -> None: pass
    @abstractmethod
    async def delete_message_group(self, root_message_id: str) -> int: pass
    @abstractmethod
    async def get_chat_statistics(self, chat_id: UUID) -> dict: pass
    @abstractmethod
    async def get_chat_statistics_bulk(self, chat_ids: List[UUID]) -> dict: pass
    @abstractmethod
    async def create_chat_reference(self, chat_id: UUID, ref_type: str, uri: str, metadata: dict = None) -> dict: pass
    @abstractmethod
    async def get_chat_reference(self, reference_id: UUID) -> Optional[dict]: pass
    @abstractmethod
    async def get_chat_reference_by_chats(self, chat_ids: List[UUID], limit: int = 100) -> List[dict]: pass
    @abstractmethod
    async def list_chat_references(self, chat_id: UUID, ref_type: str = None) -> List[dict]: pass
    @abstractmethod
    async def delete_chat_reference(self, reference_id: UUID) -> bool: pass
    @abstractmethod
    async def create_chat_summary(self, chat_id: UUID, summary: str, is_auto_generated: bool = True) -> Any: pass
    @abstractmethod
    async def get_chat_summary(self, chat_id: UUID) -> Optional[Any]: pass
    @abstractmethod
    async def list_chat_summaries(self, limit: int = 50, offset: int = 0) -> List[Any]: pass
    @abstractmethod
    async def search_chat_summaries(self, query: str, limit: int = 20) -> List[dict]: pass

class IMCPRepository(ABC):
    @abstractmethod
    async def create_server(self, name: str, command: str, args: List[str], env: dict, server_type: str = "stdio") -> dict: pass
    @abstractmethod
    async def get_server(self, server_id: UUID) -> Optional[dict]: pass
    @abstractmethod
    async def get_server_by_name(self, name: str) -> Optional[dict]: pass
    @abstractmethod
    async def list_servers(self, enabled_only: bool = False) -> List[dict]: pass
    @abstractmethod
    async def update_server_status(self, server_id: UUID, status: str, error_msg: str = None) -> dict: pass
    @abstractmethod
    async def update_server_health(self, server_id: UUID, is_healthy: bool, latency_ms: int = None, error_msg: str = None) -> dict: pass
    @abstractmethod
    async def update_server(self, server_id: UUID, updates: dict) -> dict: pass
    @abstractmethod
    async def delete_server(self, server_id: UUID) -> bool: pass
    @abstractmethod
    async def upsert_tools(self, server_id: UUID, tools: List[dict]) -> List[dict]: pass
    @abstractmethod
    async def get_tools(self, server_id: UUID = None) -> List[dict]: pass
    @abstractmethod
    async def get_tool(self, tool_name: str) -> Optional[dict]: pass
    @abstractmethod
    async def log_execution(self, server_id: UUID, tool_name: str, arguments: dict) -> UUID: pass
    @abstractmethod
    async def update_execution(self, execution_id: UUID, status: str, result: str = None, error_msg: str = None, duration_ms: int = None) -> None: pass
    @abstractmethod
    async def get_execution_history(self, server_id: UUID = None, limit: int = 50, offset: int = 0) -> List[dict]: pass
    @abstractmethod
    async def get_server_stats(self, server_id: UUID) -> dict: pass

class IConfigurationRepository(ABC):
    @abstractmethod
    def read_config(self) -> dict: pass
    @abstractmethod
    def write_config(self, config: dict) -> None: pass

class IStorageRepository(ABC):
    @abstractmethod
    async def get_all_artifacts(self, limit: int = 100, offset: int = 0) -> List[dict]: pass
    @abstractmethod
    async def get_storage_statistics(self) -> dict: pass
    @abstractmethod
    async def save_traceability_data(self, request_id: str, data: dict) -> None: pass
    @abstractmethod
    async def load_traceability_data(self, request_id: str) -> Optional[dict]: pass
    @abstractmethod
    async def save_trail_state(self, group_id: str, trail_data: dict) -> None: pass
    @abstractmethod
    async def load_trail_state(self, group_id: str) -> Optional[dict]: pass
    @abstractmethod
    async def delete_trail_state(self, group_id: str) -> None: pass

class ISearchIndexesRepository(ABC):
    @abstractmethod
    async def register_index(self, index_name: str, source_type: str, index_directory: str, chunk_count: int, display_name: str, description: str, metadata: dict) -> dict: pass
    @abstractmethod
    async def get_index(self, index_name: str) -> Optional[dict]: pass
    @abstractmethod
    async def list_indexes(self) -> List[dict]: pass
    @abstractmethod
    async def remove_index(self, index_name: str) -> bool: pass

class IProfileRepository(ABC):
    @abstractmethod
    async def read_profile_preview(self, profile_path: str) -> dict: pass
