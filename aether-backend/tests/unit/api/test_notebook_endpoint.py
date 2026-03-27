"""
Notebook Runtime Endpoint Tests

Covers all routes in api/v1/endpoints/notebook.py:
  POST /v1/notebook/sys-path/add
  GET  /v1/notebook/sys-path/list
  POST /v1/notebook/import
  POST /v1/notebook/import/from-path
  POST /v1/notebook/packages/list
  POST /v1/notebook/modules/info
  GET  /v1/notebook/sessions
  POST /v1/execute/notebook
  GET  /v1/notebook/health

Mocking strategy:
  - nb_* functions: patched to avoid real runtime operations
  - require_local_request: satisfied by test environment (TESTING=1)
  - settings.security.allow_notebook_exec: patched for execution tests
"""

import pytest
from unittest.mock import patch, MagicMock


# ===================================================================
# POST /v1/notebook/sys-path/add
# ===================================================================


class TestSysPathAdd:

    @pytest.mark.asyncio
    async def test_add_path_success(self, client):
        """Successfully add path to sys.path."""
        with patch(
            "api.v1.endpoints.notebook.nb_sys_path_add",
            return_value={"success": True, "path": "/tmp/test", "count": 5},
        ):
            resp = await client.post("/v1/notebook/sys-path/add", json={
                "path": "/tmp/test",
                "prepend": True,
            })

        assert resp.status_code == 200
        assert resp.json()["success"] is True

    @pytest.mark.asyncio
    async def test_add_path_failure(self, client):
        """Failed add returns 400."""
        with patch(
            "api.v1.endpoints.notebook.nb_sys_path_add",
            return_value={"success": False, "error": "Path does not exist"},
        ):
            resp = await client.post("/v1/notebook/sys-path/add", json={
                "path": "/nonexistent/path",
                "prepend": True,
            })

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_add_path_missing_field(self, client):
        """Missing required 'path' field returns 422."""
        resp = await client.post("/v1/notebook/sys-path/add", json={
            "prepend": True,
        })

        assert resp.status_code == 422


# ===================================================================
# GET /v1/notebook/sys-path/list
# ===================================================================


class TestSysPathList:

    @pytest.mark.asyncio
    async def test_list_sys_path(self, client):
        """List returns paths and count."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_sys_path",
            return_value={"paths": ["/usr/lib/python3.11", "/app"], "count": 2},
        ):
            resp = await client.get("/v1/notebook/sys-path/list")

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 2
        assert len(body["paths"]) == 2

    @pytest.mark.asyncio
    async def test_list_sys_path_exception(self, client):
        """Exception returns 500."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_sys_path",
            side_effect=RuntimeError("sys broken"),
        ):
            resp = await client.get("/v1/notebook/sys-path/list")

        assert resp.status_code == 500


# ===================================================================
# POST /v1/notebook/import
# ===================================================================


class TestImportModule:

    @pytest.mark.asyncio
    async def test_import_success(self, client):
        """Successful module import."""
        with patch(
            "api.v1.endpoints.notebook.nb_import",
            return_value={"success": True, "module": "numpy", "version": "1.24.0"},
        ):
            resp = await client.post("/v1/notebook/import", json={
                "module": "numpy",
            })

        assert resp.status_code == 200
        assert resp.json()["success"] is True

    @pytest.mark.asyncio
    async def test_import_failure(self, client):
        """Failed import returns 400."""
        with patch(
            "api.v1.endpoints.notebook.nb_import",
            return_value={"success": False, "error": "ModuleNotFoundError: No module named 'nonexistent'"},
        ):
            resp = await client.post("/v1/notebook/import", json={
                "module": "nonexistent",
            })

        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_import_with_alias(self, client):
        """Import with alias parameter."""
        with patch(
            "api.v1.endpoints.notebook.nb_import",
            return_value={"success": True, "module": "numpy", "alias": "np"},
        ):
            resp = await client.post("/v1/notebook/import", json={
                "module": "numpy",
                "alias": "np",
                "add_to_builtins": True,
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_import_with_fromlist(self, client):
        """Import with fromlist parameter."""
        with patch(
            "api.v1.endpoints.notebook.nb_import",
            return_value={"success": True, "module": "os.path", "symbols": ["join", "exists"]},
        ):
            resp = await client.post("/v1/notebook/import", json={
                "module": "os.path",
                "fromlist": ["join", "exists"],
            })

        assert resp.status_code == 200


# ===================================================================
# POST /v1/notebook/import/from-path
# ===================================================================


class TestImportFromPath:

    @pytest.mark.asyncio
    async def test_import_from_path_success(self, client):
        """Import from file path succeeds."""
        with patch(
            "api.v1.endpoints.notebook.nb_import_from_path",
            return_value={"success": True, "module": "mymod", "path": "/tmp/mymod.py"},
        ):
            resp = await client.post("/v1/notebook/import/from-path", json={
                "module": "mymod",
                "path": "/tmp/mymod.py",
            })

        assert resp.status_code == 200
        assert resp.json()["success"] is True

    @pytest.mark.asyncio
    async def test_import_from_path_failure(self, client):
        """Failed path import returns 400."""
        with patch(
            "api.v1.endpoints.notebook.nb_import_from_path",
            return_value={"success": False, "error": "File not found"},
        ):
            resp = await client.post("/v1/notebook/import/from-path", json={
                "module": "mymod",
                "path": "/nonexistent.py",
            })

        assert resp.status_code == 400


# ===================================================================
# POST /v1/notebook/packages/list
# ===================================================================


class TestListPackages:

    @pytest.mark.asyncio
    async def test_list_packages_success(self, client):
        """List packages returns package data."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_installed",
            return_value={"packages": [{"name": "pytest", "version": "7.0"}], "count": 1},
        ):
            resp = await client.post("/v1/notebook/packages/list", json={
                "method": "metadata",
            })

        assert resp.status_code == 200
        body = resp.json()
        assert body["count"] == 1

    @pytest.mark.asyncio
    async def test_list_packages_with_search(self, client):
        """Package search filter works."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_installed",
            return_value={"packages": [{"name": "numpy", "version": "1.24"}], "count": 1},
        ):
            resp = await client.post("/v1/notebook/packages/list", json={
                "method": "metadata",
                "search": "numpy",
                "limit": 10,
            })

        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_list_packages_error(self, client):
        """Error in listing returns 500."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_installed",
            return_value={"error": "Failed to enumerate packages"},
        ):
            resp = await client.post("/v1/notebook/packages/list", json={
                "method": "metadata",
            })

        assert resp.status_code == 500


# ===================================================================
# POST /v1/notebook/modules/info
# ===================================================================


class TestModuleInfo:

    @pytest.mark.asyncio
    async def test_module_info_success(self, client):
        """Known module returns info."""
        with patch(
            "api.v1.endpoints.notebook.nb_module_info",
            return_value={
                "name": "json",
                "file": "/usr/lib/python3.11/json/__init__.py",
                "doc": "JSON encoder and decoder",
                "members": ["dumps", "loads"],
            },
        ):
            resp = await client.post("/v1/notebook/modules/info", json={
                "module": "json",
            })

        assert resp.status_code == 200
        assert resp.json()["name"] == "json"

    @pytest.mark.asyncio
    async def test_module_info_not_found(self, client):
        """Unknown module returns 404."""
        with patch(
            "api.v1.endpoints.notebook.nb_module_info",
            return_value={"error": "Module not found: fakemodule"},
        ):
            resp = await client.post("/v1/notebook/modules/info", json={
                "module": "fakemodule",
            })

        assert resp.status_code == 404


# ===================================================================
# GET /v1/notebook/health
# ===================================================================


class TestNotebookHealth:

    @pytest.mark.asyncio
    async def test_health_returns_healthy(self, client):
        """Health check returns healthy with capabilities."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_sys_path",
            return_value={"count": 10},
        ):
            resp = await client.get("/v1/notebook/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is True
        assert body["sys_path_count"] == 10
        assert "code_execution" in body["capabilities"]

    @pytest.mark.asyncio
    async def test_health_returns_unhealthy_on_error(self, client):
        """Health check returns unhealthy when runtime fails."""
        with patch(
            "api.v1.endpoints.notebook.nb_list_sys_path",
            side_effect=RuntimeError("runtime crashed"),
        ):
            resp = await client.get("/v1/notebook/health")

        assert resp.status_code == 200
        body = resp.json()
        assert body["healthy"] is False
        assert body["capabilities"] == []


# ===================================================================
# POST /v1/execute/notebook
# ===================================================================


class TestExecuteNotebook:

    @pytest.mark.asyncio
    async def test_execute_simple_code(self, client):
        """Execute simple Python code returns output."""
        resp = await client.post("/v1/execute/notebook", json={
            "code": "print('hello world')",
        })

        # Depends on settings.security.allow_notebook_exec
        assert resp.status_code in (200, 403)
        if resp.status_code == 200:
            body = resp.json()
            assert body["success"] is True
            assert "hello world" in body["output"]

    @pytest.mark.asyncio
    async def test_execute_disabled_returns_403(self, app, client):
        """Execution disabled by config returns 403."""
        from api.dependencies import get_settings, require_local_request_dependency
        mock_settings = MagicMock()
        mock_settings.security.allow_notebook_exec = False
        app.dependency_overrides[get_settings] = lambda: mock_settings
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            resp = await client.post("/v1/execute/notebook", json={
                "code": "print('test')",
            })
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    @pytest.mark.asyncio
    async def test_execute_missing_code_returns_422(self, client):
        """Missing required 'code' field returns 422."""
        resp = await client.post("/v1/execute/notebook", json={})

        assert resp.status_code == 422


# ===================================================================
# GET /v1/notebook/sessions
# ===================================================================


class TestNotebookSessions:

    @pytest.mark.asyncio
    async def test_sessions_returns_empty_list(self, client):
        """Sessions endpoint returns empty list (no active sessions)."""
        resp = await client.get("/v1/notebook/sessions")

        # Depends on settings.security.allow_notebook_exec
        assert resp.status_code in (200, 403)
        if resp.status_code == 200:
            body = resp.json()
            assert body["sessions"] == []
            assert body["count"] == 0

    @pytest.mark.asyncio
    async def test_sessions_success_with_exec_enabled(self, client, app):
        """Line 468: sessions returns {sessions: [], count: 0} when exec allowed."""
        from api.dependencies import get_settings as _get_settings
        from unittest.mock import MagicMock

        mock_settings = MagicMock()
        mock_settings.security.allow_notebook_exec = True
        mock_settings.security.require_local_only = False
        app.dependency_overrides[_get_settings] = lambda: mock_settings
        try:
            resp = await client.get("/v1/notebook/sessions")
            assert resp.status_code == 200
            body = resp.json()
            assert body["sessions"] == []
            assert body["count"] == 0
        finally:
            app.dependency_overrides.pop(_get_settings, None)


# ===================================================================
# Deep Coverage: Exception paths in CRUD endpoints
# ===================================================================


class TestEndpointExceptions:

    async def test_sys_path_add_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.nb_sys_path_add",
                    side_effect=RuntimeError("unexpected crash")):
            resp = await client.post("/v1/notebook/sys-path/add", json={
                "path": "/tmp/test", "prepend": True,
            })
        assert resp.status_code == 500

    async def test_import_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.nb_import",
                    side_effect=RuntimeError("import crash")):
            resp = await client.post("/v1/notebook/import", json={
                "module": "os",
            })
        assert resp.status_code == 500

    async def test_import_from_path_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.nb_import_from_path",
                    side_effect=RuntimeError("path crash")):
            resp = await client.post("/v1/notebook/import/from-path", json={
                "module": "mymod", "path": "/tmp/mymod.py",
            })
        assert resp.status_code == 500

    async def test_list_packages_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.nb_list_installed",
                    side_effect=RuntimeError("pkg crash")):
            resp = await client.post("/v1/notebook/packages/list", json={
                "method": "metadata",
            })
        assert resp.status_code == 500

    async def test_module_info_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.nb_module_info",
                    side_effect=RuntimeError("info crash")):
            resp = await client.post("/v1/notebook/modules/info", json={
                "module": "json",
            })
        assert resp.status_code == 500


# ===================================================================
# Deep Coverage: execute_code full path
# ===================================================================


class TestExecuteCodeDeep:
    """
    To reach the execute_code body, we must:
    1. Override require_local_request_dependency (router-level dep) via app.dependency_overrides
    2. Override get_settings to enable allow_notebook_exec=True
    """

    @staticmethod
    def _mock_settings():
        mock_s = MagicMock()
        mock_s.security.allow_notebook_exec = True
        mock_s.security.bind_host = "127.0.0.1"
        mock_s.security.bind_port = 8000
        mock_s.security.allowed_hosts = ["*"]
        mock_s.environment = "test"
        return mock_s

    async def test_execute_code_with_output(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_s = self._mock_settings()
        app.dependency_overrides[get_settings] = lambda: mock_s
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            with patch("api.v1.endpoints.notebook.require_local_request"), \
                 patch("api.v1.endpoints.notebook.get_runtime_engine",
                       return_value=MagicMock(), create=True):
                resp = await client.post("/v1/execute/notebook", json={
                    "code": "print('hello')",
                })
            assert resp.status_code == 200
            assert resp.json()["success"] is True
            assert "hello" in resp.json()["output"]
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    async def test_execute_code_no_engine(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_s = self._mock_settings()
        app.dependency_overrides[get_settings] = lambda: mock_s
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            with patch("api.v1.endpoints.notebook.require_local_request"), \
                 patch("api.dependencies.get_runtime_engine",
                       return_value=None):
                resp = await client.post("/v1/execute/notebook", json={
                    "code": "print('test')",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
            assert "not available" in body["error"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    async def test_execute_code_syntax_error(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_s = self._mock_settings()
        app.dependency_overrides[get_settings] = lambda: mock_s
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            with patch("api.v1.endpoints.notebook.require_local_request"), \
                 patch("api.v1.endpoints.notebook.get_runtime_engine",
                       return_value=MagicMock(), create=True):
                resp = await client.post("/v1/execute/notebook", json={
                    "code": "def broken(",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is False
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    async def test_execute_code_with_stderr(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_s = self._mock_settings()
        app.dependency_overrides[get_settings] = lambda: mock_s
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            code = "import sys; print('out'); print('err', file=sys.stderr)"
            with patch("api.v1.endpoints.notebook.require_local_request"), \
                 patch("api.v1.endpoints.notebook.get_runtime_engine",
                       return_value=MagicMock(), create=True):
                resp = await client.post("/v1/execute/notebook", json={
                    "code": code,
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "STDERR" in body["output"]
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    async def test_execute_code_no_output(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_s = self._mock_settings()
        app.dependency_overrides[get_settings] = lambda: mock_s
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            with patch("api.v1.endpoints.notebook.require_local_request"), \
                 patch("api.v1.endpoints.notebook.get_runtime_engine",
                       return_value=MagicMock(), create=True):
                resp = await client.post("/v1/execute/notebook", json={
                    "code": "x = 42",
                })
            assert resp.status_code == 200
            body = resp.json()
            assert body["success"] is True
            assert "no output" in body["output"].lower()
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)


# ===================================================================
# Deep Coverage: list_sessions
# ===================================================================


class TestListSessionsDeep:

    @pytest.mark.asyncio
    async def test_sessions_disabled_returns_403(self, app, client):
        from api.dependencies import get_settings, require_local_request_dependency
        mock_settings = MagicMock()
        mock_settings.security.allow_notebook_exec = False
        app.dependency_overrides[get_settings] = lambda: mock_settings
        app.dependency_overrides[require_local_request_dependency] = lambda: None
        try:
            resp = await client.get("/v1/notebook/sessions")
            assert resp.status_code == 403
        finally:
            app.dependency_overrides.pop(get_settings, None)
            app.dependency_overrides.pop(require_local_request_dependency, None)

    async def test_sessions_generic_exception(self, client):
        with patch("api.v1.endpoints.notebook.require_local_request",
                    side_effect=RuntimeError("unexpected")):
            resp = await client.get("/v1/notebook/sessions")
        assert resp.status_code == 500
