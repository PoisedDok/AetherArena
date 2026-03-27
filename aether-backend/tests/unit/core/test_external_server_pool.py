"""
Tests for core.integrations.providers.open_interpreter.external_server_pool.

Covers:
- ExternalOIServerPool constructor validation (15 validation paths)
- Orphan process cleanup, stale log cleanup
- Port allocation, server lifecycle (ensure, stop, evict)
- Process spawn, health check, termination
- LRU and TTL eviction strategies
"""

import signal
import subprocess
import time
import itertools
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch, mock_open

import pytest

from core.integrations.providers.open_interpreter.external_server_pool import (
    ExternalOIServerPool,
    ExternalOIServerRecord,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def pool_dir(tmp_path):
    """Create temp files needed for pool init validation."""
    venv = tmp_path / "python"
    venv.touch()
    wrapper = tmp_path / "wrapper.py"
    wrapper.touch()
    logs = tmp_path / "logs"
    logs.mkdir()
    return {
        "base_external_url": "http://127.0.0.1:9000",
        "host_override": None,
        "port_min": 9100,
        "port_max": 9110,
        "max_servers": 3,
        "ttl_seconds": 300,
        "startup_timeout_seconds": 30.0,
        "venv_python": str(venv),
        "wrapper_script": str(wrapper),
        "backend_url": "http://127.0.0.1:8765",
        "auth_token": "test-token",
        "logs_dir": str(logs),
    }


def _make_pool(params):
    """Create pool with init cleanup mocked out."""
    with patch.object(ExternalOIServerPool, "_kill_orphaned_oi_servers"), \
         patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
        return ExternalOIServerPool(**params)


def _mock_proc(alive=True, pid=12345):
    """Create a mock subprocess.Popen."""
    p = MagicMock(spec=subprocess.Popen)
    p.pid = pid
    p.poll.return_value = None if alive else 0
    return p


def _make_record(chat_id="chat-1", port=9100, alive=True, last_used=None):
    """Create an ExternalOIServerRecord with mock proc."""
    proc = _mock_proc(alive=alive)
    return ExternalOIServerRecord(
        chat_id=chat_id,
        host="127.0.0.1",
        port=port,
        http_url=f"http://127.0.0.1:{port}",
        ws_url=f"ws://127.0.0.1:{port}/",
        pid=proc.pid,
        started_at=time.time() - 60,
        last_used=last_used or time.time(),
        _proc=proc,
        _log_fp=None,
    )


# ---------------------------------------------------------------------------
# Constructor validation
# ---------------------------------------------------------------------------

class TestPoolInit:
    def test_valid_params(self, pool_dir):
        pool = _make_pool(pool_dir)
        assert pool._host == "127.0.0.1"
        assert pool._port_min == 9100
        assert pool._port_max == 9110
        assert pool._max_servers == 3
        assert pool._ttl_seconds == 300
        assert pool._scheme_http == "http"
        assert pool._scheme_ws == "ws"
        assert pool._auth_token == "test-token"

    def test_https_scheme(self, pool_dir):
        pool_dir["base_external_url"] = "https://secure.host:443"
        pool = _make_pool(pool_dir)
        assert pool._scheme_http == "https"
        assert pool._scheme_ws == "wss"

    def test_host_override(self, pool_dir):
        pool_dir["host_override"] = "custom-host"
        pool = _make_pool(pool_dir)
        assert pool._host == "custom-host"

    def test_auth_token_none(self, pool_dir):
        pool_dir["auth_token"] = None
        pool = _make_pool(pool_dir)
        assert pool._auth_token is None

    def test_auth_token_whitespace(self, pool_dir):
        pool_dir["auth_token"] = "   "
        pool = _make_pool(pool_dir)
        assert pool._auth_token is None

    def test_backend_url_trailing_slash_stripped(self, pool_dir):
        pool_dir["backend_url"] = "http://127.0.0.1:8765/"
        pool = _make_pool(pool_dir)
        assert pool._backend_url == "http://127.0.0.1:8765"

    def test_missing_base_url(self, pool_dir):
        pool_dir["base_external_url"] = ""
        with pytest.raises(ValueError, match="base_external_url"):
            _make_pool(pool_dir)

    def test_invalid_scheme(self, pool_dir):
        pool_dir["base_external_url"] = "ftp://host:21"
        with pytest.raises(ValueError, match="http"):
            _make_pool(pool_dir)

    def test_missing_hostname(self, pool_dir):
        pool_dir["base_external_url"] = "http://:9000"
        with pytest.raises(ValueError, match="hostname"):
            _make_pool(pool_dir)

    def test_invalid_port_range(self, pool_dir):
        pool_dir["port_min"] = 9200
        pool_dir["port_max"] = 9100
        with pytest.raises(ValueError, match="port range"):
            _make_pool(pool_dir)

    def test_zero_port(self, pool_dir):
        pool_dir["port_min"] = 0
        with pytest.raises(ValueError, match="port range"):
            _make_pool(pool_dir)

    def test_max_servers_zero(self, pool_dir):
        pool_dir["max_servers"] = 0
        with pytest.raises(ValueError, match="max_servers"):
            _make_pool(pool_dir)

    def test_ttl_zero(self, pool_dir):
        pool_dir["ttl_seconds"] = 0
        with pytest.raises(ValueError, match="ttl_seconds"):
            _make_pool(pool_dir)

    def test_startup_timeout_zero(self, pool_dir):
        pool_dir["startup_timeout_seconds"] = 0
        with pytest.raises(ValueError, match="startup_timeout"):
            _make_pool(pool_dir)

    def test_missing_venv_python(self, pool_dir):
        pool_dir["venv_python"] = ""
        with pytest.raises(ValueError, match="venv_python"):
            _make_pool(pool_dir)

    def test_missing_wrapper_script(self, pool_dir):
        pool_dir["wrapper_script"] = ""
        with pytest.raises(ValueError, match="wrapper_script"):
            _make_pool(pool_dir)

    def test_venv_python_not_exists(self, pool_dir):
        pool_dir["venv_python"] = "/nonexistent/python"
        with pytest.raises(ValueError, match="does not exist"):
            _make_pool(pool_dir)

    def test_wrapper_script_not_exists(self, pool_dir):
        pool_dir["wrapper_script"] = "/nonexistent/wrapper.py"
        with pytest.raises(ValueError, match="does not exist"):
            _make_pool(pool_dir)

    def test_missing_backend_url(self, pool_dir):
        pool_dir["backend_url"] = ""
        with pytest.raises(ValueError, match="backend_url"):
            _make_pool(pool_dir)

    def test_missing_logs_dir(self, pool_dir):
        pool_dir["logs_dir"] = ""
        with pytest.raises(ValueError, match="logs_dir"):
            _make_pool(pool_dir)

    def test_host_override_empty(self, pool_dir):
        pool_dir["host_override"] = "   "
        with pytest.raises(ValueError, match="host is required"):
            _make_pool(pool_dir)

    def test_logs_dir_created(self, pool_dir):
        new_logs = str(Path(pool_dir["logs_dir"]) / "sub" / "dir")
        pool_dir["logs_dir"] = new_logs
        _make_pool(pool_dir)
        assert Path(new_logs).is_dir()


# ---------------------------------------------------------------------------
# Static helpers
# ---------------------------------------------------------------------------

class TestGetPidOnPort:
    def test_returns_pid(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "12345\n"
        with patch("subprocess.run", return_value=mock_result):
            pid = ExternalOIServerPool._get_pid_on_port(9100)
        assert pid == 12345

    def test_multiple_pids_returns_first(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "12345\n67890\n"
        with patch("subprocess.run", return_value=mock_result):
            pid = ExternalOIServerPool._get_pid_on_port(9100)
        assert pid == 12345

    def test_no_process(self):
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        with patch("subprocess.run", return_value=mock_result):
            assert ExternalOIServerPool._get_pid_on_port(9100) is None

    def test_non_digit_output(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "not-a-pid\n"
        with patch("subprocess.run", return_value=mock_result):
            assert ExternalOIServerPool._get_pid_on_port(9100) is None

    def test_file_not_found(self):
        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert ExternalOIServerPool._get_pid_on_port(9100) is None


class TestIsOiWrapperProcess:
    def test_linux_proc_match(self):
        with patch("os.path.exists", return_value=True), \
             patch("builtins.open", MagicMock(
                 return_value=MagicMock(
                     __enter__=lambda s: MagicMock(read=lambda: b"python\x00oi_server_wrapper\x00--port\x009100"),
                     __exit__=lambda s, *a: None,
                 )
             )):
            assert ExternalOIServerPool._is_oi_wrapper_process(12345) is True

    def test_linux_proc_no_match(self):
        with patch("os.path.exists", return_value=True), \
             patch("builtins.open", MagicMock(
                 return_value=MagicMock(
                     __enter__=lambda s: MagicMock(read=lambda: b"python\x00other_script"),
                     __exit__=lambda s, *a: None,
                 )
             )):
            assert ExternalOIServerPool._is_oi_wrapper_process(12345) is False

    def test_macos_ps_fallback(self):
        mock_result = MagicMock()
        mock_result.stdout = "/usr/bin/python oi_server_wrapper.py --port 9100"
        with patch("os.path.exists", return_value=False), \
             patch("subprocess.run", return_value=mock_result):
            assert ExternalOIServerPool._is_oi_wrapper_process(12345) is True

    def test_macos_ps_no_match(self):
        mock_result = MagicMock()
        mock_result.stdout = "/usr/bin/python some_other.py"
        with patch("os.path.exists", return_value=False), \
             patch("subprocess.run", return_value=mock_result):
            assert ExternalOIServerPool._is_oi_wrapper_process(12345) is False

    def test_error_returns_false(self):
        with patch("os.path.exists", side_effect=OSError):
            assert ExternalOIServerPool._is_oi_wrapper_process(12345) is False


class TestIsPortFree:
    def test_free_port(self):
        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_socket_cls.return_value.__enter__ = lambda s: mock_sock
            mock_socket_cls.return_value.__exit__ = lambda s, *a: None
            assert ExternalOIServerPool._is_port_free(9999) is True

    def test_occupied_port(self):
        with patch("socket.socket") as mock_socket_cls:
            mock_sock = MagicMock()
            mock_sock.bind.side_effect = OSError("Address in use")
            mock_socket_cls.return_value.__enter__ = lambda s: mock_sock
            mock_socket_cls.return_value.__exit__ = lambda s, *a: None
            assert ExternalOIServerPool._is_port_free(9999) is False


# ---------------------------------------------------------------------------
# Orphan/stale cleanup
# ---------------------------------------------------------------------------

class TestKillOrphanedOiServers:
    def test_kills_orphaned_processes(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", return_value=99999), \
             patch.object(ExternalOIServerPool, "_is_oi_wrapper_process", return_value=True), \
             patch("os.killpg") as mock_killpg, \
             patch("time.sleep"), \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            pool = ExternalOIServerPool(**pool_dir)
        import signal
        # Called once per port in the pool — every call uses the same pid/signal
        assert mock_killpg.call_count >= 1
        for call in mock_killpg.call_args_list:
            assert call == ((99999, signal.SIGTERM),)

    def test_skips_free_ports(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=True), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port") as mock_get_pid, \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            ExternalOIServerPool(**pool_dir)
        mock_get_pid.assert_not_called()

    def test_skips_non_oi_processes(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", return_value=99999), \
             patch.object(ExternalOIServerPool, "_is_oi_wrapper_process", return_value=False), \
             patch("os.killpg") as mock_killpg, \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            ExternalOIServerPool(**pool_dir)
        mock_killpg.assert_not_called()

    def test_skips_no_pid(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", return_value=None), \
             patch.object(ExternalOIServerPool, "_is_oi_wrapper_process") as mock_is_oi, \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            ExternalOIServerPool(**pool_dir)
        mock_is_oi.assert_not_called()

    def test_killpg_fails_falls_back_to_kill(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", return_value=99999), \
             patch.object(ExternalOIServerPool, "_is_oi_wrapper_process", return_value=True), \
             patch("os.killpg", side_effect=OSError), \
             patch("os.kill") as mock_kill, \
             patch("time.sleep"), \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            ExternalOIServerPool(**pool_dir)
        mock_kill.assert_called_with(99999, signal.SIGTERM)

    def test_both_kill_fail_gracefully(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", return_value=99999), \
             patch.object(ExternalOIServerPool, "_is_oi_wrapper_process", return_value=True), \
             patch("os.killpg", side_effect=OSError), \
             patch("os.kill", side_effect=OSError), \
             patch("time.sleep"), \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            # Should not raise
            ExternalOIServerPool(**pool_dir)

    def test_exception_in_loop_gracefully_handled(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_is_port_free", return_value=False), \
             patch.object(ExternalOIServerPool, "_get_pid_on_port", side_effect=RuntimeError("unexpected")), \
             patch.object(ExternalOIServerPool, "_clean_stale_oi_logs"):
            # Should not raise
            ExternalOIServerPool(**pool_dir)


class TestCleanStaleLogs:
    def test_removes_matching_files(self, pool_dir):
        logs = Path(pool_dir["logs_dir"])
        (logs / "oi-server-chat-abc12345-9100.log").touch()
        (logs / "oi-server-9100.ready").touch()
        (logs / "unrelated.txt").touch()

        with patch.object(ExternalOIServerPool, "_kill_orphaned_oi_servers"):
            ExternalOIServerPool(**pool_dir)

        assert not (logs / "oi-server-chat-abc12345-9100.log").exists()
        assert not (logs / "oi-server-9100.ready").exists()
        assert (logs / "unrelated.txt").exists()

    def test_handles_oserror(self, pool_dir):
        with patch.object(ExternalOIServerPool, "_kill_orphaned_oi_servers"), \
             patch("pathlib.Path.glob", side_effect=OSError("perm")):
            # Should not raise
            _make_pool(pool_dir)


# ---------------------------------------------------------------------------
# Core lifecycle methods
# ---------------------------------------------------------------------------

class TestListServers:
    def test_returns_servers(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record()
        pool._servers["chat-1"] = rec
        result = pool.list_servers()
        assert len(result) == 1
        assert result[0] is rec


class TestEnsureServer:
    @pytest.mark.asyncio
    async def test_returns_existing_alive(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100, alive=True)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock):
            result, started_new = await pool.ensure_server("chat-1")

        assert started_new is False
        assert result is rec

    @pytest.mark.asyncio
    async def test_replaces_dead_server(self, pool_dir):
        pool = _make_pool(pool_dir)
        dead_rec = _make_record("chat-1", 9100, alive=False)
        pool._servers["chat-1"] = dead_rec
        pool._ports_in_use[9100] = "chat-1"

        new_rec = _make_record("chat-1", 9101)

        async def mock_stop(chat_id):
            pool._servers.pop(chat_id, None)
            pool._ports_in_use.pop(9100, None)

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_stop_locked", side_effect=mock_stop), \
             patch.object(pool, "_allocate_port_locked", return_value=9101), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", new_callable=AsyncMock, return_value=new_rec):
            result, started_new = await pool.ensure_server("chat-1")

        assert started_new is True
        assert result is new_rec

    @pytest.mark.asyncio
    async def test_evicts_lru_at_capacity(self, pool_dir):
        pool_dir["max_servers"] = 1
        pool = _make_pool(pool_dir)
        old_rec = _make_record("old-chat", 9100)
        pool._servers["old-chat"] = old_rec
        pool._ports_in_use[9100] = "old-chat"

        new_rec = _make_record("new-chat", 9101)

        async def mock_stop(chat_id):
            pool._servers.pop(chat_id, None)
            pool._ports_in_use.pop(9100, None)

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_stop_locked", side_effect=mock_stop), \
             patch.object(pool, "_allocate_port_locked", return_value=9101), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", new_callable=AsyncMock, return_value=new_rec):
            result, started_new = await pool.ensure_server("new-chat")

        assert started_new is True

    @pytest.mark.asyncio
    async def test_cleans_port_on_spawn_failure(self, pool_dir):
        pool = _make_pool(pool_dir)
        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_allocate_port_locked", return_value=9100), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", new_callable=AsyncMock, side_effect=RuntimeError("spawn fail")):
            with pytest.raises(RuntimeError, match="spawn fail"):
                await pool.ensure_server("chat-1")
        assert 9100 not in pool._ports_in_use

    @pytest.mark.asyncio
    async def test_invalid_chat_id_raises(self, pool_dir):
        pool = _make_pool(pool_dir)
        with pytest.raises(ValueError, match="chat_id"):
            await pool.ensure_server("")

    @pytest.mark.asyncio
    async def test_race_condition_other_created(self, pool_dir):
        """If another coroutine created a server during spawn, the new one is killed."""
        pool = _make_pool(pool_dir)
        existing = _make_record("chat-1", 9100, alive=True)
        new_rec = _make_record("chat-1", 9101)

        async def mock_spawn(**kwargs):
            # Simulate race: another coroutine added a server while we were spawning
            pool._servers["chat-1"] = existing
            pool._ports_in_use[9100] = "chat-1"
            return new_rec

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_allocate_port_locked", return_value=9101), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", side_effect=mock_spawn), \
             patch.object(pool, "_terminate_process", new_callable=AsyncMock) as mock_term:
            result, started_new = await pool.ensure_server("chat-1")

        assert started_new is False
        assert result is existing
        mock_term.assert_awaited_once()


class TestTouch:
    @pytest.mark.asyncio
    async def test_updates_last_used(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1")
        rec.last_used = 1000.0
        pool._servers["chat-1"] = rec
        await pool.touch("chat-1")
        assert rec.last_used > 1000.0

    @pytest.mark.asyncio
    async def test_nonexistent_no_error(self, pool_dir):
        pool = _make_pool(pool_dir)
        await pool.touch("nonexistent")  # Should not raise


class TestStopServer:
    @pytest.mark.asyncio
    async def test_stops_server(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool.stop_server("chat-1")
        assert "chat-1" not in pool._servers
        assert 9100 not in pool._ports_in_use


class TestStopAll:
    @pytest.mark.asyncio
    async def test_stops_all(self, pool_dir):
        pool = _make_pool(pool_dir)
        pool._servers["a"] = _make_record("a", 9100)
        pool._servers["b"] = _make_record("b", 9101)
        pool._ports_in_use[9100] = "a"
        pool._ports_in_use[9101] = "b"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool.stop_all()
        assert len(pool._servers) == 0
        assert len(pool._ports_in_use) == 0


# ---------------------------------------------------------------------------
# Internal locked helpers
# ---------------------------------------------------------------------------

class TestCleanupStaleLocked:
    @pytest.mark.asyncio
    async def test_evicts_expired(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("old", 9100, last_used=time.time() - 9999)
        pool._servers["old"] = rec
        pool._ports_in_use[9100] = "old"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._cleanup_stale_locked()
        assert "old" not in pool._servers

    @pytest.mark.asyncio
    async def test_keeps_fresh(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("fresh", 9100, last_used=time.time())
        pool._servers["fresh"] = rec
        await pool._cleanup_stale_locked()
        assert "fresh" in pool._servers


class TestEvictLruLocked:
    @pytest.mark.asyncio
    async def test_evicts_oldest(self, pool_dir):
        pool = _make_pool(pool_dir)
        old = _make_record("old", 9100, last_used=time.time() - 100)
        new = _make_record("new", 9101, last_used=time.time())
        pool._servers["old"] = old
        pool._servers["new"] = new
        pool._ports_in_use[9100] = "old"
        pool._ports_in_use[9101] = "new"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._evict_lru_locked()
        assert "old" not in pool._servers
        assert "new" in pool._servers

    @pytest.mark.asyncio
    async def test_empty_no_error(self, pool_dir):
        pool = _make_pool(pool_dir)
        await pool._evict_lru_locked()


class TestAllocatePortLocked:
    def test_returns_first_free(self, pool_dir):
        pool_dir["port_min"] = 9100
        pool_dir["port_max"] = 9102
        pool = _make_pool(pool_dir)
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_is_port_free", return_value=True):
            port = pool._allocate_port_locked()
        assert port == 9101

    def test_skips_in_use_and_occupied(self, pool_dir):
        pool_dir["port_min"] = 9100
        pool_dir["port_max"] = 9102
        pool = _make_pool(pool_dir)
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_is_port_free", side_effect=[False, True]):
            port = pool._allocate_port_locked()
        assert port == 9102

    def test_no_free_port_raises(self, pool_dir):
        pool_dir["port_min"] = 9100
        pool_dir["port_max"] = 9100
        pool = _make_pool(pool_dir)
        pool._ports_in_use[9100] = "chat-1"
        with pytest.raises(RuntimeError, match="No free port"):
            pool._allocate_port_locked()


class TestStopLocked:
    @pytest.mark.asyncio
    async def test_stops_and_cleans(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._stop_locked("chat-1")
        assert "chat-1" not in pool._servers
        assert 9100 not in pool._ports_in_use

    @pytest.mark.asyncio
    async def test_removes_sentinel_file(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        sentinel = Path(pool_dir["logs_dir"]) / "oi-server-9100.ready"
        sentinel.touch()
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._stop_locked("chat-1")
        assert not sentinel.exists()

    @pytest.mark.asyncio
    async def test_closes_log_fp(self, pool_dir):
        pool = _make_pool(pool_dir)
        mock_fp = MagicMock()
        rec = _make_record("chat-1", 9100)
        rec._log_fp = mock_fp
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._stop_locked("chat-1")
        mock_fp.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_nonexistent_clears_reservations(self, pool_dir):
        pool = _make_pool(pool_dir)
        pool._ports_in_use[9100] = "chat-1"
        pool._ports_in_use[9101] = "__reserved__:chat-1"
        await pool._stop_locked("chat-1")
        assert 9100 not in pool._ports_in_use
        assert 9101 not in pool._ports_in_use

    @pytest.mark.asyncio
    async def test_terminate_failure_still_cleans(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock, side_effect=RuntimeError):
            with pytest.raises(RuntimeError):
                await pool._stop_locked("chat-1")
        # pop() happened before try block; port cleaned before try block; finally ran too
        assert "chat-1" not in pool._servers
        assert 9100 not in pool._ports_in_use


class TestIsAlive:
    def test_alive(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record(alive=True)
        assert pool._is_alive(rec) is True

    def test_dead(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record(alive=False)
        assert pool._is_alive(rec) is False

    def test_oserror(self, pool_dir):
        pool = _make_pool(pool_dir)
        rec = _make_record()
        rec._proc.poll.side_effect = OSError
        assert pool._is_alive(rec) is False


# ---------------------------------------------------------------------------
# Spawn and health
# ---------------------------------------------------------------------------

class TestSpawnAndWait:
    @pytest.mark.asyncio
    async def test_success(self, pool_dir):
        pool = _make_pool(pool_dir)
        mock_proc = _mock_proc(alive=True, pid=54321)

        with patch("subprocess.Popen", return_value=mock_proc), \
             patch.object(pool, "_wait_healthy", new_callable=AsyncMock), \
             patch("builtins.open", mock_open()):
            rec = await pool._spawn_and_wait(chat_id="chat-1", port=9100)

        assert rec.chat_id == "chat-1"
        assert rec.port == 9100
        assert rec.pid == 54321
        assert rec.http_url == "http://127.0.0.1:9100"
        assert rec.ws_url == "ws://127.0.0.1:9100/"

    @pytest.mark.asyncio
    async def test_includes_auth_in_cmd(self, pool_dir):
        pool = _make_pool(pool_dir)
        mock_proc = _mock_proc()

        with patch("subprocess.Popen", return_value=mock_proc) as mock_popen, \
             patch.object(pool, "_wait_healthy", new_callable=AsyncMock), \
             patch("builtins.open", mock_open()):
            await pool._spawn_and_wait(chat_id="chat-1", port=9100)

        cmd = mock_popen.call_args[0][0]
        assert "--auth=test-token" in cmd

    @pytest.mark.asyncio
    async def test_no_auth_token(self, pool_dir):
        pool_dir["auth_token"] = None
        pool = _make_pool(pool_dir)
        mock_proc = _mock_proc()

        with patch("subprocess.Popen", return_value=mock_proc) as mock_popen, \
             patch.object(pool, "_wait_healthy", new_callable=AsyncMock), \
             patch("builtins.open", mock_open()):
            await pool._spawn_and_wait(chat_id="chat-1", port=9100)

        cmd = mock_popen.call_args[0][0]
        assert "--auth" not in cmd

    @pytest.mark.asyncio
    async def test_health_failure_cleans_up(self, pool_dir):
        pool = _make_pool(pool_dir)
        mock_proc = _mock_proc()
        m_open = mock_open()

        with patch("subprocess.Popen", return_value=mock_proc), \
             patch.object(pool, "_wait_healthy", new_callable=AsyncMock, side_effect=RuntimeError("unhealthy")), \
             patch.object(pool, "_terminate_process", new_callable=AsyncMock) as mock_term, \
             patch("builtins.open", m_open):
            with pytest.raises(RuntimeError, match="unhealthy"):
                await pool._spawn_and_wait(chat_id="chat-1", port=9100)

        mock_term.assert_awaited_once_with(mock_proc)
        m_open().close.assert_called_once()


class TestWaitHealthy:
    @pytest.mark.asyncio
    async def test_heartbeat_succeeds_sentinel_found(self, pool_dir):
        pool = _make_pool(pool_dir)
        sentinel = Path(pool_dir["logs_dir"]) / "oi-server-9100.ready"
        sentinel.touch()

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await pool._wait_healthy("http://127.0.0.1:9100", port=9100)

    @pytest.mark.asyncio
    async def test_heartbeat_timeout(self, pool_dir):
        pool_dir["startup_timeout_seconds"] = 0.1
        pool = _make_pool(pool_dir)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=ConnectionError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            with pytest.raises(RuntimeError, match="did not become healthy"):
                await pool._wait_healthy("http://127.0.0.1:9100", port=9100)

    @pytest.mark.asyncio
    async def test_sentinel_not_found_warns_but_proceeds(self, pool_dir):
        pool_dir["startup_timeout_seconds"] = 0.1
        pool = _make_pool(pool_dir)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            # No sentinel file — should warn but not raise
            await pool._wait_healthy("http://127.0.0.1:9100", port=9100)

    @pytest.mark.asyncio
    async def test_no_port_skips_sentinel(self, pool_dir):
        pool = _make_pool(pool_dir)

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            await pool._wait_healthy("http://127.0.0.1:9100", port=0)


# ---------------------------------------------------------------------------
# Process termination
# ---------------------------------------------------------------------------

class TestTerminateProcess:
    @pytest.mark.asyncio
    async def test_already_dead(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=False)
        with patch("os.killpg") as mock_killpg:
            await pool._terminate_process(proc)
        mock_killpg.assert_not_called()

    @pytest.mark.asyncio
    async def test_graceful_exit(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        # After SIGTERM, process exits
        proc.poll.side_effect = [None, 0]

        with patch("os.killpg"), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            await pool._terminate_process(proc)

    @pytest.mark.asyncio
    async def test_killpg_fails_falls_back(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        proc.poll.side_effect = [None, 0]

        with patch("os.killpg", side_effect=OSError), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            await pool._terminate_process(proc)
        proc.terminate.assert_called_once()

    @pytest.mark.asyncio
    async def test_hard_kill_after_timeout(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        # Never exits gracefully
        proc.poll.return_value = None

        with patch("os.killpg") as mock_killpg, \
             patch("asyncio.sleep", new_callable=AsyncMock), \
             patch("core.integrations.providers.open_interpreter.external_server_pool.time.time", side_effect=itertools.count(0, 3)):  # Simulate timeout
            await pool._terminate_process(proc)
        # Should have been called with SIGKILL
        killpg_calls = mock_killpg.call_args_list
        assert any(c[0][1] == signal.SIGKILL for c in killpg_calls)

    @pytest.mark.asyncio
    async def test_poll_oserror_returns(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc()
        proc.poll.side_effect = OSError
        await pool._terminate_process(proc)

    @pytest.mark.asyncio
    async def test_hard_kill_killpg_fails(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        proc.poll.return_value = None

        with patch("os.killpg", side_effect=[None, OSError]), \
             patch("asyncio.sleep", new_callable=AsyncMock), \
             patch("core.integrations.providers.open_interpreter.external_server_pool.time.time", side_effect=itertools.count(0, 3)):
            await pool._terminate_process(proc)
        proc.kill.assert_called_once()

    @pytest.mark.asyncio
    async def test_all_kill_attempts_fail(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        proc.poll.return_value = None
        proc.terminate.side_effect = OSError
        proc.kill.side_effect = OSError

        with patch("os.killpg", side_effect=OSError), \
             patch("asyncio.sleep", new_callable=AsyncMock), \
             patch("core.integrations.providers.open_interpreter.external_server_pool.time.time", side_effect=itertools.count(0, 3)):
            # Should not raise
            await pool._terminate_process(proc)

    @pytest.mark.asyncio
    async def test_poll_oserror_during_wait(self, pool_dir):
        pool = _make_pool(pool_dir)
        proc = _mock_proc(alive=True)
        # First poll: alive, then OSError during wait loop
        proc.poll.side_effect = [None, OSError]

        with patch("os.killpg"), \
             patch("asyncio.sleep", new_callable=AsyncMock):
            await pool._terminate_process(proc)


# ---------------------------------------------------------------------------
# ExternalOIServerRecord dataclass
# ---------------------------------------------------------------------------

class TestCleanStaleLogsEdgeCases:
    def test_unlink_oserror_skipped(self, pool_dir):
        """Line 237: OSError on individual unlink is skipped."""
        logs = Path(pool_dir["logs_dir"])
        f = logs / "oi-server-chat-abc12345-9100.log"
        f.touch()
        with patch.object(ExternalOIServerPool, "_kill_orphaned_oi_servers"), \
             patch.object(Path, "unlink", side_effect=OSError("perm")):
            ExternalOIServerPool(**pool_dir)

    def test_overall_oserror(self, pool_dir):
        """Lines 241-242: OSError wrapping entire cleanup logged but not raised."""
        with patch.object(ExternalOIServerPool, "_kill_orphaned_oi_servers"), \
             patch("pathlib.Path.glob", side_effect=OSError("disk fail")):
            # Should not raise
            ExternalOIServerPool(**pool_dir)


class TestStopLockedOSErrors:
    @pytest.mark.asyncio
    async def test_log_fp_close_oserror(self, pool_dir):
        """Line 361: OSError on log_fp.close() swallowed."""
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        mock_fp = MagicMock()
        mock_fp.close.side_effect = OSError("close fail")
        rec._log_fp = mock_fp
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            await pool._stop_locked("chat-1")
        assert "chat-1" not in pool._servers

    @pytest.mark.asyncio
    async def test_sentinel_unlink_oserror(self, pool_dir):
        """Line 368: OSError on sentinel.unlink() swallowed."""
        pool = _make_pool(pool_dir)
        rec = _make_record("chat-1", 9100)
        pool._servers["chat-1"] = rec
        pool._ports_in_use[9100] = "chat-1"
        sentinel = Path(pool_dir["logs_dir"]) / "oi-server-9100.ready"
        sentinel.touch()
        with patch.object(pool, "_terminate_process", new_callable=AsyncMock), \
             patch.object(Path, "unlink", side_effect=OSError("unlink fail")):
            await pool._stop_locked("chat-1")
        assert "chat-1" not in pool._servers


class TestEnsureServerRaceLogFp:
    @pytest.mark.asyncio
    async def test_race_with_log_fp(self, pool_dir):
        """Lines 289-290: log_fp closed when race detected and new rec has log file."""
        pool = _make_pool(pool_dir)
        existing = _make_record("chat-1", 9100, alive=True)
        new_rec = _make_record("chat-1", 9101)
        mock_fp = MagicMock()
        new_rec._log_fp = mock_fp

        async def mock_spawn(**kwargs):
            pool._servers["chat-1"] = existing
            pool._ports_in_use[9100] = "chat-1"
            return new_rec

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_allocate_port_locked", return_value=9101), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", side_effect=mock_spawn), \
             patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            result, started_new = await pool.ensure_server("chat-1")

        assert started_new is False
        mock_fp.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_race_log_fp_close_oserror(self, pool_dir):
        """Line 290: OSError on log_fp.close in race branch is swallowed."""
        pool = _make_pool(pool_dir)
        existing = _make_record("chat-1", 9100, alive=True)
        new_rec = _make_record("chat-1", 9101)
        mock_fp = MagicMock()
        mock_fp.close.side_effect = OSError("close fail")
        new_rec._log_fp = mock_fp

        async def mock_spawn(**kwargs):
            pool._servers["chat-1"] = existing
            pool._ports_in_use[9100] = "chat-1"
            return new_rec

        with patch.object(pool, "_cleanup_stale_locked", new_callable=AsyncMock), \
             patch.object(pool, "_allocate_port_locked", return_value=9101), \
             patch.object(pool, "_is_port_free", return_value=True), \
             patch.object(pool, "_spawn_and_wait", side_effect=mock_spawn), \
             patch.object(pool, "_terminate_process", new_callable=AsyncMock):
            result, started_new = await pool.ensure_server("chat-1")
        assert started_new is False


class TestSpawnLogFpOSError:
    @pytest.mark.asyncio
    async def test_log_fp_close_oserror_on_health_fail(self, pool_dir):
        """Line 426: OSError on log_fp.close after health failure swallowed."""
        pool = _make_pool(pool_dir)
        mock_proc = _mock_proc()
        m_open = mock_open()
        m_open().close.side_effect = OSError("close fail")

        with patch("subprocess.Popen", return_value=mock_proc), \
             patch.object(pool, "_wait_healthy", new_callable=AsyncMock, side_effect=RuntimeError("unhealthy")), \
             patch.object(pool, "_terminate_process", new_callable=AsyncMock), \
             patch("builtins.open", m_open):
            with pytest.raises(RuntimeError, match="unhealthy"):
                await pool._spawn_and_wait(chat_id="chat-1", port=9100)
        # close() was attempted despite OSError
        m_open().close.assert_called_once()


class TestRecord:
    def test_fields(self):
        proc = _mock_proc()
        rec = ExternalOIServerRecord(
            chat_id="c", host="h", port=1, http_url="http://h:1",
            ws_url="ws://h:1/", pid=1, started_at=0, last_used=0, _proc=proc,
        )
        assert rec.chat_id == "c"
        assert rec._log_fp is None
