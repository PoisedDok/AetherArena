"""
Unit Tests: OIToolCatalogBridge (core/integrations/framework/oi_catalog.py)

Covers tool generation from OpenAPI spec, category mapping, tool wrapper creation,
OI registration, and the convenience register_backend_tools_with_oi function.

Mock boundaries:
- FastAPI app.openapi() → mock OpenAPI spec
- settings.config_dir → tmp_path for registry
- httpx.Client → mock for tool wrapper execution
- httpx.get → mock for _fetch_openapi_spec
"""

from __future__ import annotations

import yaml
from pathlib import Path
from typing import Any, Dict
from unittest.mock import MagicMock, patch

import pytest

from core.integrations.framework.oi_catalog import (
    OIToolCatalogBridge,
    register_backend_tools_with_oi,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_settings(tmp_path: Path, base_url: str = "http://127.0.0.1:8765") -> MagicMock:
    settings = MagicMock()
    settings.config_dir = tmp_path
    settings.base_url = base_url
    settings.app_version = "1.0.0"
    settings.http_client = MagicMock()
    settings.http_client.external_service_timeout = 10.0
    return settings


def _write_registry(config_dir: Path, integrations: Dict[str, Any] | None = None) -> None:
    config_dir.mkdir(parents=True, exist_ok=True)
    content = {"integrations": integrations or {}}
    (config_dir / "integrations_registry.yaml").write_text(yaml.dump(content))


def _make_app(spec: Dict[str, Any] | None = None) -> MagicMock:
    app = MagicMock()
    if spec is None:
        spec = {"paths": {}, "info": {"title": "Test"}}
    app.openapi.return_value = spec
    return app


def _make_bridge(tmp_path: Path, *, spec=None, integrations=None, base_url="http://127.0.0.1:8765"):
    _write_registry(tmp_path, integrations)
    return OIToolCatalogBridge(_make_app(spec), _make_settings(tmp_path, base_url))


def _endpoint(summary="Test", tags=None, parameters=None, request_body=None, is_agent_tool=True):
    s = {"summary": summary}
    if is_agent_tool:
        s["is_agent_tool"] = True
    if tags:
        s["tags"] = tags
    if parameters:
        s["parameters"] = parameters
    if request_body:
        s["requestBody"] = request_body
    return s


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    def test_loads_registry(self, tmp_path):
        _write_registry(tmp_path, {"ocr": {"enabled": True}})
        bridge = OIToolCatalogBridge(_make_app(), _make_settings(tmp_path))
        assert bridge._registry["integrations"]["ocr"]["enabled"] is True

    def test_missing_registry(self, tmp_path):
        settings = _make_settings(tmp_path / "nonexistent")
        bridge = OIToolCatalogBridge(_make_app(), settings)
        assert bridge._registry == {"integrations": {}}


# ─── _create_tool_from_endpoint ──────────────────────────────────────────────


class TestCreateToolFromEndpoint:
    def test_skips_without_agent_tool_flag(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._create_tool_from_endpoint("/v1/some/path", "post", _endpoint(is_agent_tool=False)) is None

    def test_creates_tool_for_valid_endpoint(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/ocr/process", "post", _endpoint(summary="OCR", tags=["ocr"])
        )
        assert tool is not None
        assert tool["path"] == "/v1/ocr/process"
        assert tool["method"] == "POST"
        assert "name" in tool

    def test_uses_first_tag(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/test", "get", _endpoint(tags=["primary", "secondary"])
        )
        assert tool is not None
        assert tool["category"] is not None

    def test_no_tags_uses_other(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/something", "get", _endpoint(tags=[])
        )
        assert tool is not None

    def test_tags_stored_as_list_not_set(self, tmp_path):
        """Regression: tags were stored as set() which is not JSON-serializable."""
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/test", "get", _endpoint(tags=["alpha", "beta"])
        )
        assert tool is not None
        assert isinstance(tool["tags"], list)
        # Must be JSON-serializable
        import json
        json.dumps(tool)  # Would crash with set()

    def test_does_not_skip_tools_path(self, tmp_path):
        """Mutation killer: L167 startswith('/v1/toolrunner') must NOT match '/v1/tools/'.
        If prefix were widened to '/v1/tool', this would break."""
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/tools/list", "get", _endpoint(tags=["tools"], summary="List tools")
        )
        assert tool is not None  # Must NOT be skipped
        assert tool["path"] == "/v1/tools/list"

    def test_does_not_skip_search_notebooks(self, tmp_path):
        """Regression: notebook search endpoint is safe and should remain cataloged."""
        bridge = _make_bridge(tmp_path)
        tool = bridge._create_tool_from_endpoint(
            "/v1/search/notebooks", "get", _endpoint(tags=["search"], summary="Search notebooks")
        )
        assert tool is not None
        assert tool["path"] == "/v1/search/notebooks"


# ─── _map_tag_to_category ────────────────────────────────────────────────────


class TestMapTagToCategory:
    def test_known_tags(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._map_tag_to_category("ocr") == "Files & Documents"
        assert bridge._map_tag_to_category("tts") == "Audio & Speech"
        assert bridge._map_tag_to_category("notebook") == "System & Terminal"
        assert bridge._map_tag_to_category("omni") == "Vision"
        assert bridge._map_tag_to_category("xlwings") == "Excel Automation"
        assert bridge._map_tag_to_category("chat") == "AI & LLM"
        assert bridge._map_tag_to_category("mcp") == "System & Terminal"

    def test_unknown_tag(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._map_tag_to_category("random") == "Other"

    def test_registry_match(self, tmp_path):
        integrations = {
            "my_service": {
                "enabled": True,
                "layer3_metadata": {"category": "web_search_extraction"},
            }
        }
        bridge = _make_bridge(tmp_path, integrations=integrations)
        assert bridge._map_tag_to_category("my_service") == "Web & Search"


# ─── _format_category ───────────────────────────────────────────────────────


class TestFormatCategory:
    def test_known_categories(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._format_category("web_search_extraction") == "Web & Search"
        assert bridge._format_category("document_processing_vision") == "Files & Documents"
        assert bridge._format_category("excel_automation_data_analysis") == "Excel Automation"
        assert bridge._format_category("mcp_tools") == "System & Terminal"

    def test_unknown_category(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._format_category("unknown_key") == "Other"


# ─── _extract_parameters ────────────────────────────────────────────────────


class TestExtractParameters:
    def test_query_params(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        spec = {"parameters": [
            {"name": "limit", "schema": {"type": "integer"}, "required": False, "description": "Max"},
        ]}
        params = bridge._extract_parameters(spec)
        assert len(params) == 1
        assert params[0]["name"] == "limit"

    def test_skips_internal_headers(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        spec = {"parameters": [
            {"name": "X-Request-ID", "schema": {"type": "string"}},
            {"name": "Authorization", "schema": {"type": "string"}},
            {"name": "chat_id", "schema": {"type": "string"}, "required": True},
        ]}
        params = bridge._extract_parameters(spec)
        assert len(params) == 1
        assert params[0]["name"] == "chat_id"

    def test_request_body(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        spec = {"requestBody": {"content": {"application/json": {"schema": {
            "type": "object",
            "properties": {"msg": {"type": "string"}},
            "required": ["msg"],
        }}}}}
        params = bridge._extract_parameters(spec)
        assert len(params) == 1
        assert params[0]["required"] is True


# ─── _format_signature ──────────────────────────────────────────────────────


class TestFormatSignature:
    def test_no_params(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        assert bridge._format_signature([]) == "()"

    def test_mixed_params(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        params = [
            {"name": "id", "required": True},
            {"name": "limit", "required": False},
        ]
        assert bridge._format_signature(params) == "(id, limit=None)"


# ─── generate_tools_from_openapi ─────────────────────────────────────────────


class TestGenerateToolsFromOpenapi:
    def test_generates_tools(self, tmp_path):
        spec = {"paths": {
            "/v1/ocr/process": {"post": _endpoint(tags=["ocr"], summary="OCR")},
            "/docs": {"get": _endpoint(tags=["internal"], is_agent_tool=False)},
        }}
        bridge = _make_bridge(tmp_path, spec=spec)
        tools = bridge.generate_tools_from_openapi()
        # /docs is skipped because it lacks is_agent_tool
        assert len(tools) == 1

    def test_skips_non_http_methods(self, tmp_path):
        spec = {"paths": {"/v1/test": {"options": _endpoint(tags=["t"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)
        assert bridge.generate_tools_from_openapi() == []

    def test_exception_returns_empty(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        bridge.app.openapi.side_effect = RuntimeError("boom")
        assert bridge.generate_tools_from_openapi() == []

    def test_fetch_openapi_when_no_app(self, tmp_path):
        _write_registry(tmp_path)
        settings = _make_settings(tmp_path)
        bridge = OIToolCatalogBridge(None, settings)

        with patch.object(bridge, "_fetch_openapi_spec", return_value={"paths": {}}):
            tools = bridge.generate_tools_from_openapi()
        assert tools == []

# ─── _fetch_openapi_spec ─────────────────────────────────────────────────────


class TestFetchOpenapiSpec:
    def test_caches_result(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        bridge._openapi_cache = {"paths": {"/cached": {}}}
        result = bridge._fetch_openapi_spec()
        assert "/cached" in result["paths"]

    def test_fetches_from_backend(self, tmp_path):
        bridge = _make_bridge(tmp_path, base_url="http://localhost:8765")
        bridge._openapi_cache = None

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"paths": {"/v1/test": {}}}
        mock_resp.raise_for_status = MagicMock()

        with patch("httpx.get", return_value=mock_resp):
            result = bridge._fetch_openapi_spec()

        assert "/v1/test" in result["paths"]
        assert bridge._openapi_cache is not None

    def test_empty_base_url_raises(self, tmp_path):
        bridge = _make_bridge(tmp_path, base_url="")
        bridge._openapi_cache = None
        with pytest.raises(RuntimeError, match="base_url is required"):
            bridge._fetch_openapi_spec()

    def test_non_dict_response_raises(self, tmp_path):
        bridge = _make_bridge(tmp_path, base_url="http://localhost:8765")
        bridge._openapi_cache = None

        mock_resp = MagicMock()
        mock_resp.json.return_value = "not a dict"
        mock_resp.raise_for_status = MagicMock()

        with patch("httpx.get", return_value=mock_resp):
            with pytest.raises(RuntimeError, match="not a JSON object"):
                bridge._fetch_openapi_spec()


# ─── _create_tool_wrapper ───────────────────────────────────────────────────


class TestCreateToolWrapper:
    def test_creates_callable(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "test_tool", "path": "/v1/test", "method": "GET", "description": "Test"}
        wrapper = bridge._create_tool_wrapper(meta)
        assert callable(wrapper)
        assert wrapper.__name__ == "test_tool"

    def test_wrapper_get_request(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "list_items", "path": "/v1/items", "method": "GET", "description": "List"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"items": []}
        mock_resp.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            result = wrapper(limit=10)

        assert result == {"items": []}

    def test_wrapper_post_with_body(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "create_item", "path": "/v1/items", "method": "POST", "description": "Create"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "123"}
        mock_resp.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.post.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            result = wrapper(body={"name": "test"})

        assert result["id"] == "123"

    def test_wrapper_invalid_body_type(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "create_item", "path": "/v1/items", "method": "POST", "description": "Create"}
        wrapper = bridge._create_tool_wrapper(meta)
        result = wrapper(body="not a dict")
        assert "error" in result

    def test_wrapper_path_params(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "get_item", "path": "/v1/items/{item_id}", "method": "GET", "description": "Get"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "42"}
        mock_resp.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            result = wrapper(item_id="42")

        assert result["id"] == "42"
        call_url = mock_client.get.call_args[0][0]
        assert "42" in call_url
        assert "{item_id}" not in call_url

    def test_wrapper_path_params_url_encoded(self, tmp_path):
        """Regression: path param values with special chars must be URL-encoded."""
        bridge = _make_bridge(tmp_path)
        meta = {"name": "get_item", "path": "/v1/items/{item_id}", "method": "GET", "description": "Get"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"id": "ok"}
        mock_resp.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            wrapper(item_id="../../admin")

        call_url = mock_client.get.call_args[0][0]
        # The traversal attempt must be percent-encoded, NOT raw slashes
        assert "../../admin" not in call_url
        assert "%2F" in call_url or "%2f" in call_url

    def test_wrapper_http_error(self, tmp_path):
        import httpx
        bridge = _make_bridge(tmp_path)
        meta = {"name": "fail", "path": "/v1/fail", "method": "GET", "description": "Fail"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Error"
        mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError("err", request=MagicMock(), response=mock_resp)

        mock_client = MagicMock()
        mock_client.get.return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            result = wrapper()

        assert "error" in result
        assert "500" in result["error"]

    def test_wrapper_unsupported_method(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "x", "path": "/v1/x", "method": "OPTIONS", "description": "X"}
        wrapper = bridge._create_tool_wrapper(meta)

        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            result = wrapper()

        assert "Unsupported" in result["error"]


# ─── register_with_oi ───────────────────────────────────────────────────────


class TestCreateToolWrapperExtraMethods:
    """Covers PUT, DELETE, PATCH wrappers, non-JSON response, and general exception."""

    def _run_method(self, tmp_path, method, *, json_response=True, raise_exc=False):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "test", "path": "/v1/things", "method": method, "description": "T"}
        wrapper = bridge._create_tool_wrapper(meta)

        import httpx

        mock_resp = MagicMock()
        if json_response:
            mock_resp.json.return_value = {"ok": True}
        else:
            mock_resp.json.side_effect = ValueError("not json")
            mock_resp.text = "plain text response"
        mock_resp.raise_for_status = MagicMock()
        if raise_exc:
            mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                "err", request=MagicMock(), response=MagicMock(status_code=502, text="bad")
            )

        mock_client = MagicMock()
        for m in ("get", "post", "put", "delete", "patch"):
            getattr(mock_client, m).return_value = mock_resp
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch("httpx.Client", return_value=mock_client):
            return wrapper()

    def test_put(self, tmp_path):
        result = self._run_method(tmp_path, "PUT")
        assert result == {"ok": True}

    def test_delete(self, tmp_path):
        result = self._run_method(tmp_path, "DELETE")
        assert result == {"ok": True}

    def test_patch(self, tmp_path):
        result = self._run_method(tmp_path, "PATCH")
        assert result == {"ok": True}

    def test_non_json_response(self, tmp_path):
        result = self._run_method(tmp_path, "GET", json_response=False)
        assert result["result"] == "plain text response"

    def test_general_exception(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        meta = {"name": "test", "path": "/v1/x", "method": "GET", "description": "T"}
        wrapper = bridge._create_tool_wrapper(meta)

        with patch("httpx.Client", side_effect=RuntimeError("connection refused")):
            result = wrapper()

        assert "connection refused" in result["error"]


class TestToolMetadataRegistration:
    """Tests lines 309-351: ToolMetadata + tool_engine registration."""

    def test_with_tool_metadata(self, tmp_path):
        spec = {"paths": {"/v1/ocr/process": {"post": _endpoint(tags=["ocr"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)

        interp = MagicMock()
        computer = MagicMock()
        interp.computer = computer

        # Make computer.tools._engine available
        mock_engine = MagicMock()
        computer.tools._engine = mock_engine

        # Mock ToolMetadata import
        mock_tm = MagicMock()
        mock_tc = MagicMock()
        mock_tc.SIMPLE = "SIMPLE"
        mock_tc.MODERATE = "MODERATE"
        mock_tc.ADVANCED = "ADVANCED"

        with patch.dict("sys.modules", {
            "interpreter": MagicMock(),
            "interpreter.core": MagicMock(),
            "interpreter.core.computer": MagicMock(),
            "interpreter.core.computer.tool_metadata": MagicMock(
                ToolMetadata=mock_tm, ToolComplexity=mock_tc
            ),
        }):
            result = bridge.register_with_oi(interp)

        assert result["success"] is True
        assert result["tools_attached"] >= 1

    def test_tool_metadata_import_error(self, tmp_path):
        spec = {"paths": {"/v1/ocr/process": {"post": _endpoint(tags=["ocr"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)

        interp = MagicMock()
        computer = MagicMock()
        interp.computer = computer

        # The ToolMetadata import happens inside register_with_oi via a local import.
        # When it fails, tools should still be attached but not registered with engine.
        # We simulate this by making the 'interpreter' package unavailable.
        real_import = __builtins__.__import__ if hasattr(__builtins__, '__import__') else __import__

        def selective_import(name, *args, **kwargs):
            if name.startswith("interpreter"):
                raise ImportError("no OI")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=selective_import):
            result = bridge.register_with_oi(interp)

        assert result["success"] is True
        assert result["tools_attached"] >= 1

    def test_tool_engine_registration_exception(self, tmp_path):
        """Lines 354-355: ToolMetadata import succeeds but constructor raises → inner except."""
        spec = {"paths": {"/v1/ocr/process": {"post": _endpoint(tags=["ocr"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)

        interp = MagicMock()
        computer = MagicMock()
        interp.computer = computer
        mock_engine = MagicMock()
        computer.tools._engine = mock_engine

        # ToolMetadata constructor raises TypeError
        mock_tm = MagicMock(side_effect=TypeError("bad args"))
        mock_tc = MagicMock()
        mock_tc.SIMPLE = "SIMPLE"
        mock_tc.MODERATE = "MODERATE"
        mock_tc.ADVANCED = "ADVANCED"

        with patch.dict("sys.modules", {
            "interpreter": MagicMock(),
            "interpreter.core": MagicMock(),
            "interpreter.core.computer": MagicMock(),
            "interpreter.core.computer.tool_metadata": MagicMock(
                ToolMetadata=mock_tm, ToolComplexity=mock_tc
            ),
        }):
            result = bridge.register_with_oi(interp)

        # Tools are still attached, but engine registration fails gracefully
        assert result["success"] is True
        assert result["tools_registered"] == 0


class TestFetchOpenapiSpecTimeout:
    """Lines 131-132: timeout extraction exception."""

    def test_timeout_extraction_exception(self, tmp_path):
        settings = _make_settings(tmp_path, base_url="http://localhost:8765")
        # Make http_client.external_service_timeout raise
        settings.http_client = MagicMock()
        type(settings.http_client).external_service_timeout = property(lambda s: (_ for _ in ()).throw(ValueError("bad")))

        bridge = OIToolCatalogBridge(_make_app(), settings)
        bridge._openapi_cache = None

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"paths": {}}
        mock_resp.raise_for_status = MagicMock()

        with patch("httpx.get", return_value=mock_resp):
            result = bridge._fetch_openapi_spec()

        assert result == {"paths": {}}


class TestCreateToolFromEndpointYamlGenNull:
    """Line 178: _create_tool_metadata returns None."""

    def test_yaml_gen_returns_none(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        with patch.object(bridge._yaml_generator, "_create_tool_metadata", return_value=None):
            result = bridge._create_tool_from_endpoint("/v1/valid", "post", _endpoint(tags=["test"]))
        assert result is None


class TestRegistryLoadException:
    """Lines 70-72: exception during YAML load."""

    def test_yaml_load_error(self, tmp_path):
        settings = _make_settings(tmp_path)
        # Make config_dir / integrations_registry.yaml exist but corrupt
        settings.config_dir.mkdir(parents=True, exist_ok=True)
        (settings.config_dir / "integrations_registry.yaml").write_text("{{bad yaml")

        bridge = OIToolCatalogBridge(_make_app(), settings)
        assert bridge._registry == {"integrations": {}}


class TestRegisterWithOI:
    def test_no_tools_generated(self, tmp_path):
        bridge = _make_bridge(tmp_path)
        interp = MagicMock()
        result = bridge.register_with_oi(interp)
        assert result["tools_generated"] == 0
        assert result["success"] is False

    def test_attaches_tools_to_computer(self, tmp_path):
        spec = {"paths": {"/v1/ocr/process": {"post": _endpoint(tags=["ocr"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)

        interp = MagicMock()
        interp.computer = MagicMock(spec=[])
        interp.computer.tools = None
        # Remove tools attr so hasattr returns False
        del interp.computer.tools

        result = bridge.register_with_oi(interp)
        assert result["tools_generated"] >= 1
        assert result["tools_attached"] >= 1
        assert result["success"] is True

    def test_outer_exception_handler(self, tmp_path):
        """Lines 369-371: interpreter.computer raises → caught by outer except."""
        spec = {"paths": {"/v1/ocr/process": {"post": _endpoint(tags=["ocr"])}}}
        bridge = _make_bridge(tmp_path, spec=spec)

        interp = MagicMock()
        type(interp).computer = property(
            lambda self: (_ for _ in ()).throw(RuntimeError("no computer"))
        )

        result = bridge.register_with_oi(interp)
        assert result["success"] is False
        assert result["tools_generated"] == 0


# ─── register_backend_tools_with_oi ─────────────────────────────────────────


class TestAdversarialOICatalog:
    """Adversarial inputs and contract verification."""

    def test_wrapper_body_as_list_rejected(self, tmp_path):
        """Lists are valid JSON bodies but the wrapper only accepts dicts."""
        bridge = _make_bridge(tmp_path)
        meta = {"name": "test", "path": "/v1/test", "method": "POST", "description": "T"}
        wrapper = bridge._create_tool_wrapper(meta)
        result = wrapper(body=[1, 2, 3])
        assert "error" in result
        assert "Invalid body type" in result["error"]

    def test_wrapper_none_base_url(self, tmp_path):
        """settings.base_url = None must return None wrapper, not crash."""
        settings = _make_settings(tmp_path)
        settings.base_url = None
        _write_registry(tmp_path)
        bridge = OIToolCatalogBridge(_make_app(), settings)
        meta = {"name": "test", "path": "/v1/test", "method": "GET", "description": "T"}
        wrapper = bridge._create_tool_wrapper(meta)
        assert wrapper is None  # No wrapper created when base_url missing

    def test_extract_parameters_none_name(self, tmp_path):
        """Parameter with name=None must be skipped (useless downstream)."""
        bridge = _make_bridge(tmp_path)
        spec = {"parameters": [{"name": None, "schema": {"type": "string"}}]}
        params = bridge._extract_parameters(spec)
        assert len(params) == 0  # Skipped — no name means no usable parameter

    def test_extract_parameters_empty_string_name(self, tmp_path):
        """Parameter with name='' must also be skipped."""
        bridge = _make_bridge(tmp_path)
        spec = {"parameters": [{"name": "", "schema": {"type": "string"}}]}
        params = bridge._extract_parameters(spec)
        assert len(params) == 0

    def test_generate_tools_returns_list(self, tmp_path):
        """generate_tools_from_openapi must always return list, never None."""
        bridge = _make_bridge(tmp_path)
        result = bridge.generate_tools_from_openapi()
        assert isinstance(result, list)

        bridge.app.openapi.side_effect = RuntimeError("fail")
        result = bridge.generate_tools_from_openapi()
        assert isinstance(result, list)

    def test_register_with_oi_return_contract(self, tmp_path):
        """register_with_oi must always return dict with 'success' key."""
        bridge = _make_bridge(tmp_path)
        interp = MagicMock()
        result = bridge.register_with_oi(interp)
        assert isinstance(result, dict)
        assert "success" in result


class TestRegisterBackendToolsWithOI:
    def test_happy_path(self, tmp_path):
        _write_registry(tmp_path)
        settings = _make_settings(tmp_path)
        app = _make_app()
        interp = MagicMock()
        interp.computer = MagicMock(spec=[])

        result = register_backend_tools_with_oi(interp, app, settings)
        assert "success" in result

    def test_exception_returns_error(self, tmp_path):
        result = register_backend_tools_with_oi(None, None, MagicMock(config_dir=tmp_path / "nope"))
        assert result["success"] is False

    def test_outer_exception_from_init(self, tmp_path):
        """Lines 494-496: OIToolCatalogBridge init raises → outer except."""
        with patch(
            "core.integrations.framework.oi_catalog.OIToolCatalogBridge",
            side_effect=RuntimeError("init fail"),
        ):
            result = register_backend_tools_with_oi(MagicMock(), MagicMock(), MagicMock())
        assert result["success"] is False
        assert "init fail" in result["error"]
