"""
Supabase Docker Module Tests

Tests for core.integrations.providers.supabase_docker

Strategy:
- Mock subprocess.run for all Docker CLI calls.
- Mock httpx.AsyncClient for HTTP health checks.
- Mock asyncio.open_connection for Redis RESP protocol.
- Use monkeypatch for environment variables and module-level constants.
- Deep assertions on exact subprocess commands, return values, and error paths.

CRITICAL: The global conftest sets SKIP_SERVICE_HEALTH_CHECK=1 which causes
ensure_supabase_running() to early-return True before exercising health-check
logic. Tests that need real health-check paths must:
  1. monkeypatch.delenv("SKIP_SERVICE_HEALTH_CHECK") to remove the bypass
  2. monkeypatch.setenv("DISABLE_DOCKER_MANAGEMENT", ...) to select the path
"""

import json
import logging
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.integrations.providers import supabase_docker


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_completed_process(
    returncode: int = 0,
    stdout: str = "",
    stderr: str = "",
) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr,
    )


def _patch_fast_time(monkeypatch):
    """Replace time.time with a generator and asyncio.sleep with a no-op."""
    def time_generator():
        current = 0
        while True:
            yield current
            current += 1

    gen = time_generator()
    monkeypatch.setattr(supabase_docker.time, "time", lambda: next(gen))

    async def fake_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(supabase_docker.asyncio, "sleep", fake_sleep)


def _enter_production_health_path(monkeypatch):
    """Remove SKIP_SERVICE_HEALTH_CHECK and force production (health-check-only) path."""
    monkeypatch.delenv("SKIP_SERVICE_HEALTH_CHECK", raising=False)
    monkeypatch.setenv("DISABLE_DOCKER_MANAGEMENT", "true")


def _enter_dev_mode(monkeypatch):
    """Remove SKIP_SERVICE_HEALTH_CHECK and force dev mode (auto-manage Docker)."""
    monkeypatch.delenv("SKIP_SERVICE_HEALTH_CHECK", raising=False)
    monkeypatch.delenv("DISABLE_DOCKER_MANAGEMENT", raising=False)


# ===========================================================================
# get_resource_path
# ===========================================================================

class TestGetResourcePath:
    def test_dev_mode_path(self):
        """Without _MEIPASS, resolves relative to __file__."""
        result = supabase_docker.get_resource_path("config/test.yaml")
        # Should be relative to the project root (4 parents up from supabase_docker.py)
        assert isinstance(result, Path)
        assert str(result).endswith("config/test.yaml")

    def test_meipass_path(self):
        """With sys._MEIPASS, falls through to _MEIPASS when env vars not set or paths don't exist."""
        # Explicitly clear env vars that get_resource_path checks before _MEIPASS.
        # This prevents test pollution from earlier tests that may leak AETHER_BACKEND_ROOT.
        clean_env = {
            "AETHER_BACKEND_ROOT": "/tmp/nonexistent_test_dir",
            "AETHER_INSTALL_DIR": "/tmp/nonexistent_test_dir",
        }
        with patch.object(supabase_docker.sys, "_MEIPASS", "/tmp/packaged", create=True), \
             patch.dict(supabase_docker.os.environ, clean_env):
            result = supabase_docker.get_resource_path("config/local.env")
        assert result == Path("/tmp/packaged/config/local.env")
    
    def test_meipass_prefers_aether_backend_root(self, tmp_path):
        """In frozen mode, AETHER_BACKEND_ROOT takes priority over _MEIPASS when file exists."""
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "local.env").write_text("test")
        
        env = {"AETHER_BACKEND_ROOT": str(tmp_path), "AETHER_INSTALL_DIR": ""}
        with patch.object(supabase_docker.sys, "_MEIPASS", "/tmp/packaged", create=True), \
             patch.dict(supabase_docker.os.environ, env):
            result = supabase_docker.get_resource_path("config/local.env")
        assert result == tmp_path / "config" / "local.env"


# ===========================================================================
# get_docker_postgres_port
# ===========================================================================

class TestGetDockerPostgresPort:
    def test_success(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout="0.0.0.0:55432\n"),
        )
        assert supabase_docker.get_docker_postgres_port() == 55432

    def test_nonzero_returncode(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1),
        )
        assert supabase_docker.get_docker_postgres_port() is None

    def test_no_colon_in_output(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout="garbage\n"),
        )
        assert supabase_docker.get_docker_postgres_port() is None

    def test_exception_returns_none(self, monkeypatch):
        def fail(*a, **kw):
            raise subprocess.TimeoutExpired(cmd="docker", timeout=5)

        monkeypatch.setattr(supabase_docker.subprocess, "run", fail)
        assert supabase_docker.get_docker_postgres_port() is None

    def test_multiple_port_mappings_takes_last(self, monkeypatch):
        """If output has multi-line mappings, takes the last colon segment."""
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout="[::]:55432\n"),
        )
        assert supabase_docker.get_docker_postgres_port() == 55432


# ===========================================================================
# get_docker_postgres_password
# ===========================================================================

class TestGetDockerPostgresPassword:
    def test_success(self, monkeypatch):
        env_output = "PATH=/usr/bin\nPOSTGRES_PASSWORD=secret123\nHOME=/root\n"
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=env_output),
        )
        assert supabase_docker.get_docker_postgres_password() == "secret123"

    def test_no_password_found(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout="PATH=/usr/bin\n"),
        )
        assert supabase_docker.get_docker_postgres_password() is None

    def test_nonzero_returncode(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1),
        )
        assert supabase_docker.get_docker_postgres_password() is None

    def test_exception_returns_none(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("fail")),
        )
        assert supabase_docker.get_docker_postgres_password() is None

    def test_password_with_equals_sign(self, monkeypatch):
        """Password containing '=' is preserved correctly (split on first '=' only)."""
        env_output = "POSTGRES_PASSWORD=abc=def=ghi\n"
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=env_output),
        )
        assert supabase_docker.get_docker_postgres_password() == "abc=def=ghi"


# ===========================================================================
# verify_config_sync
# ===========================================================================

class TestVerifyConfigSync:
    def test_env_file_not_exists(self, monkeypatch, tmp_path):
        env_file = tmp_path / "nope.env"
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        ok, msg = supabase_docker.verify_config_sync()
        assert ok is False
        assert msg == f"Configuration file not found: {env_file}"

    def test_password_not_in_env_file(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("OTHER_VAR=value\n")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        ok, msg = supabase_docker.verify_config_sync()
        assert ok is False
        assert msg == "POSTGRES_PASSWORD not found in local.env"

    def test_docker_password_none(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("POSTGRES_PASSWORD=expected\n")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        monkeypatch.setattr(supabase_docker, "get_docker_postgres_password", lambda: None)
        ok, msg = supabase_docker.verify_config_sync()
        assert ok is False
        assert msg == "Cannot retrieve password from Docker container (not running?)"

    def test_password_mismatch(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("POSTGRES_PASSWORD=expected\n")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        monkeypatch.setattr(supabase_docker, "get_docker_postgres_password", lambda: "actual_different")
        ok, msg = supabase_docker.verify_config_sync()
        assert ok is False
        # Source: f"Password mismatch: container using old password (length {len(actual)}) vs local.env (length {len(expected)})"
        assert msg == f"Password mismatch: container using old password (length {len('actual_different')}) vs local.env (length {len('expected')})"

    def test_password_matches(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("POSTGRES_PASSWORD=correct_pw\n")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        monkeypatch.setattr(supabase_docker, "get_docker_postgres_password", lambda: "correct_pw")
        ok, msg = supabase_docker.verify_config_sync()
        assert ok is True
        assert msg == "Configuration synchronized"

    def test_env_file_read_error(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("x")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        with patch("builtins.open", side_effect=PermissionError("denied")):
            ok, msg = supabase_docker.verify_config_sync()
        assert ok is False
        assert msg == "Failed to read local.env: denied"


# ===========================================================================
# force_config_resync
# ===========================================================================

class TestForceConfigResync:
    def test_dir_not_exists(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path / "nope")
        assert supabase_docker.force_config_resync() is False

    def test_stop_fails(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1, stderr="stop error"),
        )
        assert supabase_docker.force_config_resync() is False

    def test_rm_fails(self, monkeypatch, tmp_path):
        call_count = {"n": 0}

        def fake_run(*a, **kw):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return _make_completed_process()  # stop succeeds
            return _make_completed_process(returncode=1, stderr="rm error")

        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(supabase_docker.subprocess, "run", fake_run)
        assert supabase_docker.force_config_resync() is False

    def test_up_fails(self, monkeypatch, tmp_path):
        call_count = {"n": 0}

        def fake_run(*a, **kw):
            call_count["n"] += 1
            if call_count["n"] <= 2:
                return _make_completed_process()  # stop + rm succeed
            return _make_completed_process(returncode=1, stderr="up error")

        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(supabase_docker.subprocess, "run", fake_run)
        assert supabase_docker.force_config_resync() is False

    def test_full_success_with_db_data_dir(self, monkeypatch, tmp_path):
        """Full success path including db data directory deletion."""
        db_data = tmp_path / "volumes" / "db" / "data"
        db_data.mkdir(parents=True)
        (db_data / "some_file").write_text("data")

        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(),
        )

        assert supabase_docker.force_config_resync() is True
        assert not db_data.exists()  # Data dir deleted

    def test_full_success_without_db_data_dir(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(),
        )
        assert supabase_docker.force_config_resync() is True

    def test_exception_returns_false(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        assert supabase_docker.force_config_resync() is False


# ===========================================================================
# _compose_base_cmd
# ===========================================================================

class TestComposeBaseCmd:
    def test_with_env_file(self, monkeypatch, tmp_path):
        env_file = tmp_path / "local.env"
        env_file.write_text("KEY=VAL\n")
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", env_file)
        cmd = supabase_docker._compose_base_cmd()
        assert cmd == ["docker", "compose", "--env-file", str(env_file)]

    def test_without_env_file(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_ENV_FILE", tmp_path / "nope.env")
        cmd = supabase_docker._compose_base_cmd()
        assert cmd == ["docker", "compose"]


# ===========================================================================
# check_docker_running
# ===========================================================================

class TestCheckDockerRunning:
    def test_docker_running(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(),
        )
        assert supabase_docker.check_docker_running() is True

    def test_docker_not_running(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1),
        )
        assert supabase_docker.check_docker_running() is False

    def test_exception_returns_false(self, monkeypatch):
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(FileNotFoundError("docker")),
        )
        assert supabase_docker.check_docker_running() is False


# ===========================================================================
# check_supabase_containers
# ===========================================================================

class TestCheckSupabaseContainers:
    def test_dir_not_exists(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path / "nope")
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False
        assert count == 0

    def test_nonzero_returncode(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False
        assert count == 0

    def test_empty_output(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=""),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False
        assert count == 0

    def test_all_critical_running(self, monkeypatch, tmp_path):
        containers = [
            {"Name": "supabase-db", "State": "Up 5 minutes (healthy)"},
            {"Name": "supabase-kong", "State": "Up 5 minutes"},
            {"Name": "supabase-rest", "State": "Up 5 minutes"},
            {"Name": "supabase-auth", "State": "Up 5 minutes"},
            {"Name": "supabase-redis", "State": "Up 5 minutes"},
            {"Name": "supabase-studio", "State": "Up 5 minutes"},
        ]
        stdout = "\n".join(json.dumps(c) for c in containers)
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=stdout),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is True
        assert count == 6

    def test_missing_critical_service(self, monkeypatch, tmp_path):
        containers = [
            {"Name": "supabase-db", "State": "Up"},
            {"Name": "supabase-kong", "State": "Up"},
            # Missing: supabase-rest, supabase-auth, supabase-redis
        ]
        stdout = "\n".join(json.dumps(c) for c in containers)
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=stdout),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False
        assert count == 2

    def test_container_not_up(self, monkeypatch, tmp_path):
        """Container exists but state is not 'Up'."""
        containers = [
            {"Name": "supabase-db", "State": "Exited (1) 5 minutes ago"},
            {"Name": "supabase-kong", "State": "Up"},
            {"Name": "supabase-rest", "State": "Up"},
            {"Name": "supabase-auth", "State": "Up"},
            {"Name": "supabase-redis", "State": "Up"},
        ]
        stdout = "\n".join(json.dumps(c) for c in containers)
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=stdout),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False  # supabase-db not "Up"

    def test_invalid_json_lines_skipped(self, monkeypatch, tmp_path):
        stdout = 'not json\n{"Name": "supabase-db", "State": "Up"}\n'
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(stdout=stdout),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert count == 1  # Only valid JSON parsed

    def test_exception_returns_false(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("fail")),
        )
        ok, count = supabase_docker.check_supabase_containers()
        assert ok is False
        assert count == 0


# ===========================================================================
# check_supabase_api_health
# ===========================================================================

class TestCheckSupabaseApiHealth:
    @pytest.mark.asyncio
    async def test_healthy_200(self, monkeypatch):
        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr(supabase_docker.httpx, "AsyncClient", lambda **kw: mock_client)
        result = await supabase_docker.check_supabase_api_health("http://localhost:54321", "key")
        assert result is True

    @pytest.mark.asyncio
    async def test_healthy_401(self, monkeypatch):
        """401 from Kong means it's alive (just unauthenticated)."""
        mock_response = MagicMock()
        mock_response.status_code = 401

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr(supabase_docker.httpx, "AsyncClient", lambda **kw: mock_client)
        result = await supabase_docker.check_supabase_api_health("http://localhost:54321", "key")
        assert result is True

    @pytest.mark.asyncio
    async def test_unhealthy_500(self, monkeypatch):
        mock_response = MagicMock()
        mock_response.status_code = 500

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr(supabase_docker.httpx, "AsyncClient", lambda **kw: mock_client)
        result = await supabase_docker.check_supabase_api_health("http://localhost:54321", "key")
        assert result is False

    @pytest.mark.asyncio
    async def test_connection_error(self, monkeypatch):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=ConnectionError("refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr(supabase_docker.httpx, "AsyncClient", lambda **kw: mock_client)
        result = await supabase_docker.check_supabase_api_health("http://localhost:54321", "key")
        assert result is False

    @pytest.mark.asyncio
    async def test_empty_anon_key_falls_back_to_env(self, monkeypatch):
        """When anon_key is empty, reads from os.environ."""
        monkeypatch.setenv("SUPABASE_ANON_KEY", "env_key")

        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        monkeypatch.setattr(supabase_docker.httpx, "AsyncClient", lambda **kw: mock_client)
        result = await supabase_docker.check_supabase_api_health("http://localhost:54321", "")
        assert result is True


# ===========================================================================
# check_redis_health
# ===========================================================================

class TestCheckRedisHealth:
    @pytest.mark.asyncio
    async def test_success(self, monkeypatch):
        class FakeReader:
            async def readline(self):
                return b"+PONG\r\n"

        class FakeWriter:
            def __init__(self):
                self.writes = []

            def write(self, data):
                self.writes.append(data)

            async def drain(self):
                pass

            def close(self):
                pass

            async def wait_closed(self):
                pass

        async def fake_open_connection(host, port):
            return FakeReader(), FakeWriter()

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fake_open_connection)
        result = await supabase_docker.check_redis_health("redis://localhost:6379/0", "test")
        assert result is True

    @pytest.mark.asyncio
    async def test_non_pong_response(self, monkeypatch):
        class FakeReader:
            async def readline(self):
                return b"-ERR unknown\r\n"

        class FakeWriter:
            def write(self, data):
                pass

            async def drain(self):
                pass

            def close(self):
                pass

            async def wait_closed(self):
                pass

        async def fake_open_connection(host, port):
            return FakeReader(), FakeWriter()

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fake_open_connection)
        result = await supabase_docker.check_redis_health("redis://localhost:6379/0")
        assert result is False

    @pytest.mark.asyncio
    async def test_connection_refused(self, monkeypatch):
        async def fail_connect(host, port):
            raise OSError("Connection refused")

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fail_connect)
        result = await supabase_docker.check_redis_health("redis://localhost:6379/0")
        assert result is False

    @pytest.mark.asyncio
    async def test_wait_closed_exception_suppressed(self, monkeypatch):
        """Exception in wait_closed() is caught in finally block."""
        class FakeReader:
            async def readline(self):
                return b"+PONG\r\n"

        class FakeWriter:
            def write(self, data):
                pass

            async def drain(self):
                pass

            def close(self):
                pass

            async def wait_closed(self):
                raise OSError("already closed")

        async def fake_open_connection(host, port):
            return FakeReader(), FakeWriter()

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fake_open_connection)
        result = await supabase_docker.check_redis_health("redis://localhost:6379/0")
        assert result is True  # Exception in cleanup doesn't affect result

    @pytest.mark.asyncio
    async def test_custom_host_port_parsed(self, monkeypatch):
        """Custom Redis URL with different host/port is parsed correctly."""
        connected_to = {}

        class FakeReader:
            async def readline(self):
                return b"+PONG\r\n"

        class FakeWriter:
            def write(self, data):
                pass

            async def drain(self):
                pass

            def close(self):
                pass

            async def wait_closed(self):
                pass

        async def fake_open_connection(host, port):
            connected_to["host"] = host
            connected_to["port"] = port
            return FakeReader(), FakeWriter()

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fake_open_connection)
        await supabase_docker.check_redis_health("redis://myredis:7777/1")
        assert connected_to["host"] == "myredis"
        assert connected_to["port"] == 7777

    @pytest.mark.asyncio
    async def test_default_host_port_for_minimal_url(self, monkeypatch):
        """If host/port are missing from URL, defaults are used."""
        connected_to = {}

        class FakeReader:
            async def readline(self):
                return b"+PONG\r\n"

        class FakeWriter:
            def write(self, data):
                pass

            async def drain(self):
                pass

            def close(self):
                pass

            async def wait_closed(self):
                pass

        async def fake_open_connection(host, port):
            connected_to["host"] = host
            connected_to["port"] = port
            return FakeReader(), FakeWriter()

        monkeypatch.setattr(supabase_docker.asyncio, "open_connection", fake_open_connection)
        await supabase_docker.check_redis_health("redis:///0")
        assert connected_to["host"] == "127.0.0.1"
        assert connected_to["port"] == 6379


# ===========================================================================
# start_supabase_containers
# ===========================================================================

class TestStartSupabaseContainers:
    def test_dir_not_exists(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path / "nope")
        assert supabase_docker.start_supabase_containers() is False

    def test_start_succeeds_containers_running(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(),
        )
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (True, 5))
        monkeypatch.setattr(supabase_docker.time, "sleep", lambda s: None)
        assert supabase_docker.start_supabase_containers() is True

    def test_start_succeeds_but_containers_not_running_falls_back(self, monkeypatch, tmp_path):
        """docker compose start succeeds but containers not running → falls back to up -d."""
        call_count = {"n": 0}

        def fake_run(*a, **kw):
            call_count["n"] += 1
            return _make_completed_process()

        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(supabase_docker.subprocess, "run", fake_run)
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (False, 0))
        monkeypatch.setattr(supabase_docker.time, "sleep", lambda s: None)

        assert supabase_docker.start_supabase_containers() is True
        assert call_count["n"] == 2  # start + up -d

    def test_start_fails_up_fails(self, monkeypatch, tmp_path):
        call_count = {"n": 0}

        def fake_run(*a, **kw):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return _make_completed_process(returncode=1)  # start fails
            return _make_completed_process(returncode=1, stderr="up error")  # up also fails

        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(supabase_docker.subprocess, "run", fake_run)
        assert supabase_docker.start_supabase_containers() is False

    def test_timeout_expired(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(
                subprocess.TimeoutExpired(cmd="docker", timeout=60),
            ),
        )
        assert supabase_docker.start_supabase_containers() is False

    def test_generic_exception(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")),
        )
        assert supabase_docker.start_supabase_containers() is False


# ===========================================================================
# stop_supabase_containers
# ===========================================================================

class TestStopSupabaseContainers:
    def test_dir_not_exists(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path / "nope")
        assert supabase_docker.stop_supabase_containers() is False

    def test_success(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(),
        )
        assert supabase_docker.stop_supabase_containers() is True

    def test_uses_compose_down_not_stop(self, monkeypatch, tmp_path):
        """REGRESSION: must use 'down' (full teardown) not 'stop' (pause only)."""
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        captured_cmds = []
        def capture_run(*args, **kwargs):
            captured_cmds.append(args[0] if args else kwargs.get("args"))
            return _make_completed_process()
        monkeypatch.setattr(supabase_docker.subprocess, "run", capture_run)

        supabase_docker.stop_supabase_containers()

        assert len(captured_cmds) == 1
        cmd = captured_cmds[0]
        assert "--remove-orphans" in cmd or "down" in cmd, f"Expected down/teardown args, got: {cmd}"
        assert "stop" not in cmd, f"Command must NOT contain 'stop': {cmd}"

    def test_custom_timeout(self, monkeypatch, tmp_path):
        """timeout_seconds parameter flows through to subprocess.run."""
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        captured_kwargs = []
        def capture_run(*args, **kwargs):
            captured_kwargs.append(kwargs)
            return _make_completed_process()
        monkeypatch.setattr(supabase_docker.subprocess, "run", capture_run)

        supabase_docker.stop_supabase_containers(timeout_seconds=15)

        assert len(captured_kwargs) == 1
        assert captured_kwargs[0]["timeout"] == 15

    def test_failure(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: _make_completed_process(returncode=1, stderr="stop err"),
        )
        assert supabase_docker.stop_supabase_containers() is False

    def test_timeout(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(
                subprocess.TimeoutExpired(cmd="docker", timeout=60),
            ),
        )
        assert supabase_docker.stop_supabase_containers() is False

    def test_generic_exception(self, monkeypatch, tmp_path):
        monkeypatch.setattr(supabase_docker, "SUPABASE_DOCKER_DIR", tmp_path)
        monkeypatch.setattr(
            supabase_docker.subprocess, "run",
            lambda *a, **kw: (_ for _ in ()).throw(OSError("fail")),
        )
        assert supabase_docker.stop_supabase_containers() is False


# ===========================================================================
# ensure_supabase_running
# ===========================================================================

class TestEnsureSupabaseRunning:
    """Tests for the central orchestration function."""

    @pytest.mark.asyncio
    async def test_skip_health_check_returns_true(self, monkeypatch):
        """SKIP_SERVICE_HEALTH_CHECK=true bypasses everything."""
        monkeypatch.setenv("SKIP_SERVICE_HEALTH_CHECK", "true")
        result = await supabase_docker.ensure_supabase_running()
        assert result is True

    @pytest.mark.asyncio
    async def test_production_no_anon_key(self, monkeypatch):
        _enter_production_health_path(monkeypatch)
        result = await supabase_docker.ensure_supabase_running(anon_key="")
        assert result is False

    @pytest.mark.asyncio
    async def test_production_both_healthy(self, monkeypatch):
        _enter_production_health_path(monkeypatch)
        _patch_fast_time(monkeypatch)

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=5,
        )
        assert result is True

    @pytest.mark.asyncio
    async def test_production_api_unhealthy_timeout(self, monkeypatch):
        _enter_production_health_path(monkeypatch)
        _patch_fast_time(monkeypatch)

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=False))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=3,
        )
        assert result is False

    @pytest.mark.asyncio
    async def test_production_redis_unhealthy_timeout(self, monkeypatch):
        _enter_production_health_path(monkeypatch)
        _patch_fast_time(monkeypatch)

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=False))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=3,
        )
        assert result is False

    @pytest.mark.asyncio
    async def test_production_default_redis_url(self, monkeypatch):
        """When redis_url is None, defaults to localhost:6379."""
        _enter_production_health_path(monkeypatch)
        _patch_fast_time(monkeypatch)

        redis_urls_seen = []

        async def capture_redis(redis_url, namespace="aether"):
            redis_urls_seen.append(redis_url)
            return True

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", capture_redis)

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url=None, max_wait_seconds=5,
        )
        assert result is True
        assert redis_urls_seen[0] == "redis://localhost:6379/0"

    @pytest.mark.asyncio
    async def test_production_both_unhealthy_reports_both(self, monkeypatch, caplog):
        """When both fail, error messages mention both services."""
        _enter_production_health_path(monkeypatch)
        _patch_fast_time(monkeypatch)

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=False))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=False))

        with caplog.at_level(logging.ERROR):
            result = await supabase_docker.ensure_supabase_running(
                anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=2,
            )
        assert result is False
        # Production path logs individual service failures (lines 523-526 of source)
        assert "Supabase API not responding" in caplog.text
        assert "Redis not responding" in caplog.text

    # --- Dev Mode Tests ---

    @pytest.mark.asyncio
    async def test_dev_docker_not_running(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: False)

        result = await supabase_docker.ensure_supabase_running(anon_key="key")
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_no_anon_key(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)

        result = await supabase_docker.ensure_supabase_running(anon_key="")
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_config_mismatch_auto_resync_success(self, monkeypatch, tmp_path):
        _enter_dev_mode(monkeypatch)
        _patch_fast_time(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (False, "mismatch"))
        monkeypatch.setattr(supabase_docker, "force_config_resync", lambda: True)
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (False, 0))
        monkeypatch.setattr(supabase_docker, "start_supabase_containers", lambda: True)
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=5,
        )
        assert result is True

    @pytest.mark.asyncio
    async def test_dev_config_mismatch_resync_fails(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (False, "mismatch"))
        monkeypatch.setattr(supabase_docker, "force_config_resync", lambda: False)

        result = await supabase_docker.ensure_supabase_running(anon_key="key")
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_config_mismatch_resync_disabled(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (False, "mismatch"))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", auto_resync_on_mismatch=False,
        )
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_already_running_healthy(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (True, 5))
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0",
        )
        assert result is True

    @pytest.mark.asyncio
    async def test_dev_already_running_api_healthy_redis_unhealthy(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (True, 5))
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=False))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0",
        )
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_already_running_api_unhealthy_waits(self, monkeypatch):
        """Containers running but API not responding → enters wait loop."""
        _enter_dev_mode(monkeypatch)
        _patch_fast_time(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (True, 5))

        call_count = {"api": 0}

        async def api_health(url, anon_key):
            call_count["api"] += 1
            return call_count["api"] >= 3  # Healthy after 2 retries

        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", api_health)
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=10,
        )
        assert result is True

    @pytest.mark.asyncio
    async def test_dev_not_running_start_fails(self, monkeypatch):
        _enter_dev_mode(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (False, 0))
        monkeypatch.setattr(supabase_docker, "start_supabase_containers", lambda: False)

        result = await supabase_docker.ensure_supabase_running(anon_key="key")
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_wait_loop_timeout(self, monkeypatch, caplog):
        """Dev mode: both services never become healthy within timeout."""
        _enter_dev_mode(monkeypatch)
        _patch_fast_time(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (False, 0))
        monkeypatch.setattr(supabase_docker, "start_supabase_containers", lambda: True)
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=False))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=False))

        with caplog.at_level(logging.ERROR):
            result = await supabase_docker.ensure_supabase_running(
                anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=3,
            )
        assert result is False

    @pytest.mark.asyncio
    async def test_dev_wait_loop_api_only_unhealthy(self, monkeypatch, caplog):
        """Only API is unhealthy in dev wait loop → error mentions API."""
        _enter_dev_mode(monkeypatch)
        _patch_fast_time(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (False, 0))
        monkeypatch.setattr(supabase_docker, "start_supabase_containers", lambda: True)
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=False))
        monkeypatch.setattr(supabase_docker, "check_redis_health", AsyncMock(return_value=True))

        with caplog.at_level(logging.ERROR):
            result = await supabase_docker.ensure_supabase_running(
                anon_key="key", redis_url="redis://localhost:6379/0", max_wait_seconds=3,
            )
        assert result is False
        # Dev path uses joined message: "Supabase API did not become healthy within Ns"
        assert "Supabase API did not become healthy within 3s" in caplog.text

    @pytest.mark.asyncio
    async def test_dev_default_redis_url(self, monkeypatch):
        """Dev mode: redis_url=None defaults to localhost:6379."""
        _enter_dev_mode(monkeypatch)
        _patch_fast_time(monkeypatch)
        monkeypatch.setattr(supabase_docker, "check_docker_running", lambda: True)
        monkeypatch.setattr(supabase_docker, "verify_config_sync", lambda: (True, "ok"))
        monkeypatch.setattr(supabase_docker, "check_supabase_containers", lambda: (True, 5))
        monkeypatch.setattr(supabase_docker, "check_supabase_api_health", AsyncMock(return_value=True))

        redis_urls_seen = []

        async def capture_redis(redis_url, namespace="aether"):
            redis_urls_seen.append(redis_url)
            return True

        monkeypatch.setattr(supabase_docker, "check_redis_health", capture_redis)

        result = await supabase_docker.ensure_supabase_running(
            anon_key="key", redis_url=None,
        )
        assert result is True
        assert redis_urls_seen[0] == "redis://localhost:6379/0"
