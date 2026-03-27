"""
Connection Manager

Thread-safe singleton for managing dynamic infrastructure connections.
Replaces global module variables for database gateway and file indexing repository.
"""

import threading
from typing import Optional, Any

class ConnectionManager:
    _instance: Optional['ConnectionManager'] = None
    _lock = threading.Lock()

    def __init__(self):
        self._database_gateway: Optional[Any] = None
        self._file_indexing_repository: Optional[Any] = None
        self._state_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> 'ConnectionManager':
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def set_database_gateway(self, gateway: Any) -> None:
        with self._state_lock:
            self._database_gateway = gateway

    def get_database_gateway(self) -> Optional[Any]:
        with self._state_lock:
            return self._database_gateway

    def set_file_indexing_repository(self, repository: Any) -> None:
        with self._state_lock:
            self._file_indexing_repository = repository

    def get_file_indexing_repository(self) -> Optional[Any]:
        with self._state_lock:
            return self._file_indexing_repository

    @classmethod
    def reset(cls) -> None:
        """For testing purposes: reset the singleton."""
        with cls._lock:
            cls._instance = None
