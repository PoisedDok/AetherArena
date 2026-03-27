import pytest
import sqlite3
from unittest.mock import patch, MagicMock
from pathlib import Path

from config.settings import Settings
from data.database.repositories.daemon_logs import DaemonLogsRepository


@pytest.fixture
def mock_settings():
    settings = MagicMock(spec=Settings)
    settings.app_root = Path("/mock/root")
    return settings


@pytest.fixture
def repo(mock_settings):
    return DaemonLogsRepository(mock_settings)


class TestDaemonLogsRepository:
    def test_get_logs_invalid_daemon(self, repo):
        with pytest.raises(ValueError, match="Invalid daemon name"):
            repo.get_logs("invalid_daemon")

    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_logs_db_not_found(self, mock_exists, repo):
        mock_exists.return_value = False
        with pytest.raises(FileNotFoundError, match="Daemon database not found"):
            repo.get_logs("browser")

    @patch("data.database.repositories.daemon_logs.sqlite3.connect")
    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_logs_success(self, mock_exists, mock_connect, repo):
        mock_exists.return_value = True
        
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.cursor.return_value = mock_cursor
        
        # Mock row factory results
        mock_row1 = {"id": 1, "message": "test1", "indexed": 0}
        mock_row2 = {"id": 2, "message": "test2", "indexed": 1}
        mock_cursor.fetchall.return_value = [mock_row1, mock_row2]

        logs = repo.get_logs("browser", limit=10, only_unindexed=False)
        
        assert len(logs) == 2
        assert logs[0]["message"] == "test1"
        assert logs[1]["message"] == "test2"
        
        # Check query string sent to sqlite
        call_args = mock_cursor.execute.call_args[0]
        query = call_args[0]
        params = call_args[1]
        
        assert "SELECT * FROM browser_logs" in query
        assert "ORDER BY timestamp DESC" in query
        assert params == [10]

    @patch("data.database.repositories.daemon_logs.sqlite3.connect")
    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_logs_with_filters(self, mock_exists, mock_connect, repo):
        mock_exists.return_value = True
        
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.cursor.return_value = mock_cursor
        mock_cursor.fetchall.return_value = []

        logs = repo.get_logs("email", limit=5, hours_back=24, only_unindexed=True)
        
        call_args = mock_cursor.execute.call_args[0]
        query = call_args[0]
        params = call_args[1]
        
        assert "SELECT * FROM email_logs" in query
        assert "timestamp >=" in query
        assert "indexed = 0" in query
        assert len(params) == 2  # one for time, one for limit
        assert params[1] == 5

    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_all_stats_db_not_found(self, mock_exists, repo):
        # Always return False for exists
        mock_exists.return_value = False
        
        stats = repo.get_all_stats()
        
        assert len(stats) == 3
        assert stats["browser"]["status"] == "not_initialized"
        assert stats["email"]["status"] == "not_initialized"
        assert stats["filesystem"]["status"] == "not_initialized"

    @patch("data.database.repositories.daemon_logs.sqlite3.connect")
    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_all_stats_success(self, mock_exists, mock_connect, repo):
        # We need exists() to return True for the .db files and maybe True/False for properties
        def exists_side_effect():
            return True
        mock_exists.side_effect = exists_side_effect
        
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.cursor.return_value = mock_cursor
        
        # Cursor execute -> fetchone needs to return results
        # First execute checks if table exists (returns something)
        # Second execute counts (returns (total, unindexed))
        mock_cursor.fetchone.side_effect = [
            ("browser_logs",), # Table exists
            (100, 20),         # Count result
            ("email_logs",),   # Table exists
            (50, 5),           # Count result
            ("fs_logs",),      # Table exists
            (200, 0),          # Count result
        ]
        
        stats = repo.get_all_stats()
        
        assert stats["browser"]["status"] == "active"
        assert stats["browser"]["total_logs"] == 100
        assert stats["browser"]["unindexed_logs"] == 20
        assert stats["browser"]["indexed_logs"] == 80
        
        assert stats["email"]["status"] == "active"
        assert stats["email"]["total_logs"] == 50
        assert stats["email"]["unindexed_logs"] == 5
        
        assert stats["filesystem"]["status"] == "active"
        assert stats["filesystem"]["total_logs"] == 200
        assert stats["filesystem"]["unindexed_logs"] == 0

    @patch("data.database.repositories.daemon_logs.sqlite3.connect")
    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_all_stats_table_not_exists(self, mock_exists, mock_connect, repo):
        mock_exists.return_value = True
        
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_connect.return_value = mock_conn
        mock_conn.cursor.return_value = mock_cursor
        
        # Return None when checking if table exists
        mock_cursor.fetchone.return_value = None
        
        stats = repo.get_all_stats()
        
        assert stats["browser"]["status"] == "initializing"
        assert stats["browser"]["total_logs"] == 0
        
        assert stats["email"]["status"] == "initializing"

    @patch("data.database.repositories.daemon_logs.sqlite3.connect")
    @patch("data.database.repositories.daemon_logs.Path.exists")
    def test_get_all_stats_exception(self, mock_exists, mock_connect, repo):
        mock_exists.return_value = True
        mock_connect.side_effect = sqlite3.OperationalError("DB Locked")
        
        stats = repo.get_all_stats()
        
        assert stats["browser"]["status"] == "error"
        assert "Internal error" in stats["browser"]["error"]
        assert stats["email"]["status"] == "error"
