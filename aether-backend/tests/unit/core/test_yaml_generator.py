"""
Unit Tests: BackendToolsYAMLGenerator (core/integrations/framework/yaml_generator.py)

Comprehensive coverage of YAML generation from OpenAPI specs and integration registry.
Tests every public and private method, all branches, error paths, and edge cases.

Mock boundaries:
- FastAPI app.openapi() → mock OpenAPI spec
- settings.config_dir → tmp_path for registry file
- settings.app_version, settings.base_url → mock strings
- yaml.dump / open → real filesystem via tmp_path
"""

from __future__ import annotations

import yaml
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch


from core.integrations.framework.yaml_generator import (
    BackendToolsYAMLGenerator,
    generate_backend_tools_yaml,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_settings(
    *,
    config_dir: Path | None = None,
    app_version: str = "1.0.0",
    base_url: str = "http://127.0.0.1:8765",
    registry_content: Dict[str, Any] | None = None,
) -> MagicMock:
    """Create a mock settings object with fields yaml_generator uses."""
    settings = MagicMock()
    settings.app_version = app_version
    settings.base_url = base_url

    if config_dir is None:
        config_dir = Path("/tmp/fake_config")
    settings.config_dir = config_dir

    return settings


def _make_app(
    *,
    openapi_spec: Dict[str, Any] | None = None,
) -> MagicMock:
    """Create a mock FastAPI app with an openapi() method."""
    app = MagicMock()
    if openapi_spec is None:
        openapi_spec = {"paths": {}, "info": {"title": "Test API", "version": "1.0.0"}}
    app.openapi.return_value = openapi_spec
    return app


def _make_registry_yaml(
    integrations: Dict[str, Any] | None = None,
) -> str:
    """Create YAML string for integrations_registry.yaml."""
    if integrations is None:
        integrations = {}
    return yaml.dump({"integrations": integrations})


def _write_registry(config_dir: Path, integrations: Dict[str, Any] | None = None) -> None:
    """Write integrations_registry.yaml in config_dir."""
    config_dir.mkdir(parents=True, exist_ok=True)
    registry_path = config_dir / "integrations_registry.yaml"
    content = {"integrations": integrations or {}}
    with open(registry_path, "w") as f:
        yaml.dump(content, f)


def _make_endpoint_spec(
    *,
    summary: str = "Test endpoint",
    description: str = "Test description",
    tags: List[str] | None = None,
    parameters: List[Dict] | None = None,
    request_body: Dict | None = None,
    is_agent_tool: bool = True,
) -> Dict[str, Any]:
    """Create mock OpenAPI endpoint spec."""
    spec: Dict[str, Any] = {
        "summary": summary,
        "description": description,
    }
    if is_agent_tool:
        spec["is_agent_tool"] = True
    if tags is not None:
        spec["tags"] = tags
    if parameters is not None:
        spec["parameters"] = parameters
    if request_body is not None:
        spec["requestBody"] = request_body
    return spec


def _make_generator(
    tmp_path: Path,
    *,
    openapi_spec: Dict[str, Any] | None = None,
    integrations: Dict[str, Any] | None = None,
    app_version: str = "1.0.0",
    base_url: str = "http://127.0.0.1:8765",
) -> BackendToolsYAMLGenerator:
    """Create a BackendToolsYAMLGenerator with real filesystem registry."""
    _write_registry(tmp_path, integrations)
    settings = _make_settings(config_dir=tmp_path, app_version=app_version, base_url=base_url)
    app = _make_app(openapi_spec=openapi_spec)
    return BackendToolsYAMLGenerator(fastapi_app=app, settings=settings)


# ─── _sanitize_identifier_segment ────────────────────────────────────────────


class TestSanitizeIdentifierSegment:
    """Tests for _sanitize_identifier_segment."""

    def test_hyphen_to_underscore(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("session-map") == "session_map"

    def test_special_chars_replaced(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("foo.bar!baz") == "foo_bar_baz"

    def test_repeated_underscores_collapsed(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("foo---bar") == "foo_bar"

    def test_leading_trailing_underscores_stripped(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("__foo__") == "foo"

    def test_empty_string(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("") == ""

    def test_none_treated_as_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment(None) == ""

    def test_already_clean_identifier(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("valid_name_123") == "valid_name_123"

    def test_whitespace_stripped(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._sanitize_identifier_segment("  foo  ") == "foo"

    def test_mixed_special_chars(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._sanitize_identifier_segment("my-api/v2.endpoint")
        assert result == "my_api_v2_endpoint"


# ─── __init__ ────────────────────────────────────────────────────────────────


class TestInit:
    """Tests for __init__."""

    def test_loads_registry_from_disk(self, tmp_path):
        integrations = {"ocr": {"enabled": True, "description": "OCR service"}}
        gen = _make_generator(tmp_path, integrations=integrations)
        assert gen._registry["integrations"]["ocr"]["enabled"] is True

    def test_missing_registry_returns_empty(self, tmp_path):
        """Registry file doesn't exist → returns empty integrations."""
        settings = _make_settings(config_dir=tmp_path / "nonexistent")
        app = _make_app()
        gen = BackendToolsYAMLGenerator(fastapi_app=app, settings=settings)
        assert gen._registry == {"integrations": {}}

    def test_caches_openapi_spec(self, tmp_path):
        spec = {"paths": {"/health": {"get": {}}}, "info": {"title": "Test"}}
        gen = _make_generator(tmp_path, openapi_spec=spec)
        assert gen._openapi_spec == spec

    def test_openapi_exception_returns_empty_dict(self, tmp_path):
        """If app.openapi() raises, _openapi_spec is empty dict."""
        _write_registry(tmp_path)
        settings = _make_settings(config_dir=tmp_path)
        app = MagicMock()
        app.openapi.side_effect = RuntimeError("No routes")
        gen = BackendToolsYAMLGenerator(fastapi_app=app, settings=settings)
        assert gen._openapi_spec == {}

    def test_stores_app_and_settings(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen.app is not None
        assert gen.settings is not None


# ─── _resolve_schema_ref ─────────────────────────────────────────────────────


class TestResolveSchemaRef:
    """Tests for _resolve_schema_ref."""

    def test_resolves_valid_ref(self, tmp_path):
        spec = {
            "paths": {},
            "components": {
                "schemas": {
                    "ChatRequest": {
                        "type": "object",
                        "properties": {"message": {"type": "string"}},
                        "required": ["message"],
                    }
                }
            },
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        result = gen._resolve_schema_ref({"$ref": "#/components/schemas/ChatRequest"})
        assert result["type"] == "object"
        assert "message" in result["properties"]

    def test_no_ref_returns_original(self, tmp_path):
        gen = _make_generator(tmp_path)
        schema = {"type": "string"}
        assert gen._resolve_schema_ref(schema) is schema

    def test_non_string_ref_returns_original(self, tmp_path):
        gen = _make_generator(tmp_path)
        schema = {"$ref": 42}
        assert gen._resolve_schema_ref(schema) is schema

    def test_external_ref_returns_original(self, tmp_path):
        gen = _make_generator(tmp_path)
        schema = {"$ref": "http://external.com/schema.json"}
        assert gen._resolve_schema_ref(schema) is schema

    def test_invalid_ref_path_returns_original(self, tmp_path):
        gen = _make_generator(tmp_path)
        schema = {"$ref": "#/components/schemas/NonExistent"}
        result = gen._resolve_schema_ref(schema)
        assert result is schema

    def test_ref_to_non_dict_returns_original(self, tmp_path):
        """If $ref resolves to a non-dict (e.g. a string), return original."""
        spec = {
            "paths": {},
            "components": {"schemas": {"BadSchema": "not_a_dict"}},
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        schema = {"$ref": "#/components/schemas/BadSchema"}
        result = gen._resolve_schema_ref(schema)
        assert result is schema


# ─── _load_integrations_registry ─────────────────────────────────────────────


class TestLoadIntegrationsRegistry:
    """Tests for _load_integrations_registry."""

    def test_loads_valid_yaml(self, tmp_path):
        integrations = {
            "ocr": {"enabled": True, "type": "service"},
            "tts": {"enabled": False, "type": "service"},
        }
        gen = _make_generator(tmp_path, integrations=integrations)
        assert len(gen._registry["integrations"]) == 2
        assert gen._registry["integrations"]["ocr"]["enabled"] is True

    def test_empty_yaml_file(self, tmp_path):
        """Empty YAML file → returns default dict."""
        tmp_path.mkdir(parents=True, exist_ok=True)
        (tmp_path / "integrations_registry.yaml").write_text("")
        settings = _make_settings(config_dir=tmp_path)
        app = _make_app()
        gen = BackendToolsYAMLGenerator(fastapi_app=app, settings=settings)
        assert gen._registry == {"integrations": {}}

    def test_corrupted_yaml_returns_default(self, tmp_path):
        """Invalid YAML content → returns default dict."""
        tmp_path.mkdir(parents=True, exist_ok=True)
        (tmp_path / "integrations_registry.yaml").write_text("{{invalid yaml: [")
        settings = _make_settings(config_dir=tmp_path)
        app = _make_app()
        gen = BackendToolsYAMLGenerator(fastapi_app=app, settings=settings)
        assert gen._registry == {"integrations": {}}


# ─── generate_yaml ───────────────────────────────────────────────────────────


class TestGenerateYaml:
    """Tests for generate_yaml."""

    def test_happy_path_writes_file(self, tmp_path):
        gen = _make_generator(tmp_path)
        output = tmp_path / "output.yaml"
        result = gen.generate_yaml(output)
        assert result is True
        assert output.exists()

        # Verify YAML structure
        with open(output) as f:
            data = yaml.safe_load(f)
        assert "metadata" in data
        assert "categories" in data
        assert "integration_info" in data

    def test_metadata_section_content(self, tmp_path):
        gen = _make_generator(
            tmp_path,
            app_version="2.0.0",
            base_url="http://localhost:9999",
        )
        output = tmp_path / "output.yaml"
        gen.generate_yaml(output)

        with open(output) as f:
            data = yaml.safe_load(f)

        meta = data["metadata"]
        assert meta["version"] == "1.0.0"
        assert meta["backend_version"] == "2.0.0"
        assert meta["backend_url"] == "http://localhost:9999"
        assert meta["source"] == "Aether Backend API"
        assert "generated" in meta

    def test_write_error_returns_false(self, tmp_path):
        gen = _make_generator(tmp_path)
        # Nonexistent parent directory → write fails
        output = tmp_path / "nonexistent_dir" / "output.yaml"
        result = gen.generate_yaml(output)
        assert result is False

    def test_generates_categories_from_openapi(self, tmp_path):
        spec = {
            "paths": {
                "/v1/ocr/process": {
                    "post": _make_endpoint_spec(
                        summary="Process OCR",
                        tags=["ocr"],
                    )
                }
            },
        }
        integrations = {
            "ocr": {
                "enabled": True,
                "description": "OCR service",
                "layer3_metadata": {"category": "ocr", "requires_service": True},
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec, integrations=integrations)
        output = tmp_path / "output.yaml"
        gen.generate_yaml(output)

        with open(output) as f:
            data = yaml.safe_load(f)

        categories = data["categories"]
        assert len(categories) > 0


# ─── _generate_metadata ─────────────────────────────────────────────────────


class TestGenerateMetadata:
    """Tests for _generate_metadata."""

    def test_counts_enabled_integrations(self, tmp_path):
        integrations = {
            "ocr": {"enabled": True},
            "tts": {"enabled": True},
            "disabled": {"enabled": False},
        }
        gen = _make_generator(tmp_path, integrations=integrations)
        meta = gen._generate_metadata()
        assert meta["total_integrations"] == 3
        assert meta["enabled_integrations"] == 2

    def test_no_integrations(self, tmp_path):
        gen = _make_generator(tmp_path, integrations={})
        meta = gen._generate_metadata()
        assert meta["total_integrations"] == 0
        assert meta["enabled_integrations"] == 0

    def test_note_field_present(self, tmp_path):
        gen = _make_generator(tmp_path)
        meta = gen._generate_metadata()
        assert "Auto-generated" in meta["note"]


# ─── _format_category_name ───────────────────────────────────────────────────


class TestFormatCategoryName:
    """Tests for _format_category_name."""

    def test_known_category_keys(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._format_category_name("health") == "System & Health"
        assert gen._format_category_name("chat") == "Chat Management"
        assert gen._format_category_name("context") == "Context & Memory"
        assert gen._format_category_name("storage") == "Artifacts & Traceability"
        assert gen._format_category_name("omni") == "Document Processing"
        assert gen._format_category_name("ocr") == "Document Processing"
        assert gen._format_category_name("datastore") == "Datastore & Search"
        assert gen._format_category_name("profiles") == "Profiles & Skills"
        assert gen._format_category_name("skills") == "Profiles & Skills"
        assert gen._format_category_name("notebook") == "Notebook & Python"
        assert gen._format_category_name("mcp") == "MCP Servers"
        assert gen._format_category_name("mcp_tools") == "MCP Servers"
        assert gen._format_category_name("tts") == "Text-to-Speech"
        assert gen._format_category_name("xlwings") == "Excel Automation"

    def test_legacy_integration_keys(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._format_category_name("web_search_extraction") == "Web Search & Extraction"
        assert gen._format_category_name("document_processing_vision") == "Document Processing"
        assert gen._format_category_name("excel_automation_data_analysis") == "Excel Automation"
        assert gen._format_category_name("browser_automation") == "Web Search & Extraction"

    def test_unknown_key_title_cases(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._format_category_name("custom_category") == "Custom Category"
        assert gen._format_category_name("some_other_key") == "Some Other Key"

    def test_single_word_key(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._format_category_name("unknown") == "Unknown"


# ─── _refine_category_by_tool_path ──────────────────────────────────────────


class TestRefineCategoryByToolPath:
    """Tests for _refine_category_by_tool_path."""

    def test_storage_chats_context_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/context"
        )
        assert result == "Context & Memory"

    def test_storage_chats_groups_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/groups"
        ) == "Trails & Hierarchy"

    def test_storage_chats_subgroups_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/subgroups"
        ) == "Trails & Hierarchy"

    def test_storage_chats_nodes_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/nodes"
        ) == "Trails & Hierarchy"

    def test_storage_chats_session_map_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/session-map"
        ) == "Trails & Hierarchy"

    def test_storage_chats_stats_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/stats"
        ) == "Trails & Hierarchy"

    def test_storage_chats_no_messages_or_artifacts_refines_to_chat(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats"
        )
        assert result == "Chat Management"

    def test_storage_health_refines(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/health"
        )
        assert result == "System & Health"

    def test_storage_artifacts_stays(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/artifacts"
        )
        assert result == "Artifacts & Traceability"

    def test_storage_messages_stays(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Artifacts & Traceability", "/v1/storage/chats/{chat_id}/messages"
        )
        assert result == "Artifacts & Traceability"

    def test_non_storage_category_unchanged(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._refine_category_by_tool_path(
            "Document Processing", "/v1/ocr/process"
        )
        assert result == "Document Processing"


# ─── _map_api_tag_to_category ────────────────────────────────────────────────


class TestMapApiTagToCategory:
    """Tests for _map_api_tag_to_category."""

    def test_known_tags(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._map_api_tag_to_category("ocr") == "ocr"
        assert gen._map_api_tag_to_category("tts") == "tts"
        assert gen._map_api_tag_to_category("notebook") == "notebook"
        assert gen._map_api_tag_to_category("omni") == "omni"
        assert gen._map_api_tag_to_category("xlwings") == "xlwings"
        assert gen._map_api_tag_to_category("backends") == "backends"
        assert gen._map_api_tag_to_category("chat") == "chat"
        assert gen._map_api_tag_to_category("files") == "files"
        assert gen._map_api_tag_to_category("profiles") == "profiles"
        assert gen._map_api_tag_to_category("skills") == "skills"
        assert gen._map_api_tag_to_category("storage") == "storage"
        assert gen._map_api_tag_to_category("mcp") == "mcp_tools"

    def test_unknown_tag_returns_other(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._map_api_tag_to_category("custom") == "other"


# ─── _get_api_description ───────────────────────────────────────────────────


class TestGetApiDescription:
    """Tests for _get_api_description."""

    def test_known_tags(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._get_api_description("ocr") == "OCR and document processing APIs"
        assert gen._get_api_description("tts") == "Text-to-speech synthesis APIs"
        assert gen._get_api_description("mcp") == "MCP server management APIs"

    def test_unknown_tag_title_cases(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._get_api_description("custom") == "Custom APIs"


# ─── _format_signature ──────────────────────────────────────────────────────


class TestFormatSignature:
    """Tests for _format_signature."""

    def test_no_params(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._format_signature("my_tool", []) == "my_tool()"

    def test_required_param(self, tmp_path):
        gen = _make_generator(tmp_path)
        params = [{"name": "chat_id", "type": "string", "required": True}]
        assert gen._format_signature("get_chat", params) == "get_chat(chat_id: string)"

    def test_optional_param(self, tmp_path):
        gen = _make_generator(tmp_path)
        params = [{"name": "limit", "type": "integer", "required": False}]
        assert gen._format_signature("list_chats", params) == "list_chats(limit: integer = None)"

    def test_mixed_params(self, tmp_path):
        gen = _make_generator(tmp_path)
        params = [
            {"name": "chat_id", "type": "string", "required": True},
            {"name": "limit", "type": "integer", "required": False},
        ]
        result = gen._format_signature("get_messages", params)
        assert result == "get_messages(chat_id: string, limit: integer = None)"


# ─── _get_api_prefix ────────────────────────────────────────────────────────


class TestGetApiPrefix:
    """Tests for _get_api_prefix."""

    def test_known_integrations(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._get_api_prefix("ocr") == "/v1/ocr"
        assert gen._get_api_prefix("tts") == "/v1/tts"
        assert gen._get_api_prefix("notebook") == "/v1/notebook"
        assert gen._get_api_prefix("omni") == "/v1/omni"
        assert gen._get_api_prefix("xlwings") == "/v1/xlwings"
        assert gen._get_api_prefix("backends") == "/v1/backends"

    def test_unknown_integration_default(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._get_api_prefix("custom") == "/v1/custom"


# ─── _extract_parameters ────────────────────────────────────────────────────


class TestExtractParameters:
    """Tests for _extract_parameters."""

    def test_query_parameters(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = {
            "parameters": [
                {
                    "name": "limit",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "integer", "default": 10},
                    "description": "Max items",
                },
                {
                    "name": "offset",
                    "in": "query",
                    "required": False,
                    "schema": {"type": "integer"},
                    "description": "Offset",
                },
            ]
        }
        params = gen._extract_parameters(spec)
        assert len(params) == 2
        assert params[0]["name"] == "limit"
        assert params[0]["type"] == "integer"
        assert params[0]["default"] == 10
        assert params[1]["name"] == "offset"

    def test_skips_internal_headers(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = {
            "parameters": [
                {"name": "X-Request-ID", "in": "header", "schema": {"type": "string"}},
                {"name": "Authorization", "in": "header", "schema": {"type": "string"}},
                {"name": "Cookie", "in": "header", "schema": {"type": "string"}},
                {"name": "user-agent", "in": "header", "schema": {"type": "string"}},
                {"name": "chat_id", "in": "path", "required": True, "schema": {"type": "string"}},
            ]
        }
        params = gen._extract_parameters(spec)
        # Only chat_id should be extracted; headers are skipped
        assert len(params) == 1
        assert params[0]["name"] == "chat_id"

    def test_request_body_properties(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = {
            "requestBody": {
                "content": {
                    "application/json": {
                        "schema": {
                            "type": "object",
                            "properties": {
                                "message": {"type": "string", "description": "User message"},
                                "stream": {"type": "boolean", "default": False},
                            },
                            "required": ["message"],
                        }
                    }
                }
            }
        }
        params = gen._extract_parameters(spec)
        assert len(params) == 2
        assert params[0]["name"] == "message"
        assert params[0]["required"] is True
        assert params[1]["name"] == "stream"
        assert params[1]["required"] is False
        assert params[1]["default"] is False

    def test_request_body_with_ref_resolution(self, tmp_path):
        """Body schema with $ref should be dereferenced."""
        spec_openapi = {
            "paths": {},
            "components": {
                "schemas": {
                    "ChatRequest": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string"},
                        },
                        "required": ["content"],
                    }
                }
            },
        }
        gen = _make_generator(tmp_path, openapi_spec=spec_openapi)
        endpoint_spec = {
            "requestBody": {
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/ChatRequest"}
                    }
                }
            }
        }
        params = gen._extract_parameters(endpoint_spec)
        assert len(params) == 1
        assert params[0]["name"] == "content"
        assert params[0]["required"] is True

    def test_fallback_body_param_for_unresolvable_schema(self, tmp_path):
        """If requestBody exists but properties can't be extracted, add 'body' param."""
        gen = _make_generator(tmp_path)
        spec = {
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {
                        "schema": {"$ref": "#/components/schemas/NonExistent"}
                    }
                },
            }
        }
        params = gen._extract_parameters(spec)
        assert len(params) == 1
        assert params[0]["name"] == "body"
        assert params[0]["type"] == "object"
        assert params[0]["required"] is True

    def test_no_params_no_body(self, tmp_path):
        gen = _make_generator(tmp_path)
        params = gen._extract_parameters({})
        assert params == []

    def test_enum_in_parameter(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = {
            "parameters": [
                {
                    "name": "format",
                    "in": "query",
                    "schema": {"type": "string", "enum": ["json", "yaml", "text"]},
                }
            ]
        }
        params = gen._extract_parameters(spec)
        assert params[0]["enum"] == ["json", "yaml", "text"]


# ─── _apply_semantic_action ──────────────────────────────────────────────────


class TestApplySemanticAction:
    """Tests for _apply_semantic_action."""

    def test_action_verb_at_start(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "search_datastore", "POST", "/v1/datastore/search", {"summary": ""}, False
        )
        assert result == "search_datastore"

    def test_action_verb_at_end(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "datastore_search", "POST", "/v1/datastore/search", {"summary": ""}, False
        )
        assert result == "search_datastore"

    def test_action_verb_in_middle(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "mcp_execute_tool", "POST", "/v1/mcp/execute/tool", {"summary": ""}, False
        )
        assert result == "execute_mcp_tool"

    def test_single_action_verb_only(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "search", "POST", "/v1/search", {"summary": ""}, False
        )
        assert result == "search_system"

    def test_get_without_id_uses_list(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats", "GET", "/v1/storage/chats", {"summary": ""}, False
        )
        assert result == "list_storage_chats"

    def test_get_with_id_uses_get(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats", "GET", "/v1/storage/chats/{chat_id}", {"summary": ""}, True
        )
        assert result == "get_storage_chats"

    def test_put_uses_update(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats", "PUT", "/v1/storage/chats/{chat_id}", {"summary": ""}, True
        )
        assert result == "update_storage_chats"

    def test_delete_uses_delete(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats", "DELETE", "/v1/storage/chats/{chat_id}", {"summary": ""}, True
        )
        assert result == "delete_storage_chats"

    def test_patch_uses_update(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats", "PATCH", "/v1/storage/chats/{chat_id}", {"summary": ""}, True
        )
        assert result == "update_storage_chats"

    def test_post_defaults_to_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "storage_chats_messages", "POST", "/v1/storage/chats/{chat_id}/messages",
            {"summary": "Create message"}, True
        )
        assert result.startswith("create_")

    def test_unknown_method_uses_call(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._apply_semantic_action(
            "something", "OPTIONS", "/v1/something", {"summary": ""}, False
        )
        assert result == "call_something"


# ─── _determine_post_action ─────────────────────────────────────────────────


class TestDeterminePostAction:
    """Tests for _determine_post_action."""

    def test_storage_chat_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._determine_post_action("/v1/storage/chats", "", "storage_chats") == "create"

    def test_live_chat_stream_returns_stream(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._determine_post_action("/v1/chat/stream", "", "chat_stream") == "stream"

    def test_live_chat_default_returns_send(self, tmp_path):
        gen = _make_generator(tmp_path)
        assert gen._determine_post_action("/v1/chat/send", "", "chat_send") == "send"

    def test_mcp_start_server(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/mcp/servers/start", "start server", "mcp_servers_start")
        assert result == "start"

    def test_mcp_register_server(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/mcp/servers", "", "mcp_servers")
        assert result == "register"

    def test_mcp_execute_tool(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/mcp/servers/tools", "execute tool", "mcp_servers_tools")
        assert result == "execute"

    def test_storage_traceability(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/storage/traceability", "", "storage_traceability")
        assert result == "save"

    def test_storage_context_summarize(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/chats/{id}/context/summarize", "", "storage_chats_context_summarize"
        )
        assert result == "create"

    def test_storage_context_summarize_no_chat(self, tmp_path):
        """Line 622: storage + context + summarize WITHOUT chat → 'create'."""
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/context/summarize", "", "storage_context_summarize"
        )
        assert result == "create"

    def test_storage_artifacts_update_message_id(self, tmp_path):
        """'link' branch requires 'storage' + 'artifacts' + 'update-message-id' without 'chat'.
        Real paths like /v1/storage/chats/.../artifacts/update-message-id hit the chat branch first."""
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/artifacts/update-message-id", "", "storage_artifacts"
        )
        assert result == "link"

    def test_storage_chats_artifacts_update_message_id_hits_chat_branch(self, tmp_path):
        """When path has both 'chat' and 'storage', chat branch wins → 'create'."""
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/chats/{id}/artifacts/update-message-id", "", "storage_chats_artifacts"
        )
        assert result == "create"

    def test_storage_messages_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/chats/{id}/messages", "", "storage_chats_messages"
        )
        assert result == "create"

    def test_storage_messages_no_chat_returns_create(self, tmp_path):
        """Line 626: storage + messages WITHOUT chat → 'create'."""
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action(
            "/v1/storage/messages", "", "storage_messages"
        )
        assert result == "create"

    def test_storage_generic_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/storage/something", "", "storage_something")
        assert result == "create"

    def test_datastore_ingest(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/datastore/ingest", "", "datastore_ingest")
        assert result == ""  # Action already in base_name

    def test_datastore_generic_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/datastore/new", "", "datastore_new")
        assert result == "create"

    def test_screenshot_returns_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/omni/screenshot", "", "omni_screenshot")
        assert result == ""

    def test_ocr_convert_returns_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/ocr/convert", "", "ocr_convert")
        assert result == ""

    def test_xlwings_create_returns_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/xlwings/create", "", "xlwings_create")
        assert result == ""

    def test_xlwings_generic_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/xlwings/process", "", "xlwings_process")
        assert result == "create"

    def test_tts_synthesize_returns_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/tts/synthesize", "", "tts_synthesize")
        assert result == ""

    def test_tts_generic_returns_synthesize(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/tts/speak", "", "tts_speak")
        assert result == "synthesize"

    def test_profiles_switch(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/profiles/switch", "", "profiles_switch")
        assert result == "switch"

    def test_skills_import(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/skills/import", "", "skills_import")
        assert result == "import"

    def test_skills_generic_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/skills/new", "", "skills_new")
        assert result == "create"

    def test_notebook_add_returns_empty(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/notebook/add", "", "notebook_add")
        assert result == ""

    def test_notebook_generic_returns_execute(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/notebook/run", "", "notebook_run")
        assert result == "execute"

    def test_generic_post_returns_create(self, tmp_path):
        gen = _make_generator(tmp_path)
        result = gen._determine_post_action("/v1/unknown/endpoint", "", "unknown_endpoint")
        assert result == "create"


# ─── _create_tool_metadata ──────────────────────────────────────────────────


class TestCreateToolMetadata:
    """Tests for _create_tool_metadata."""

    def test_basic_endpoint(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(
            summary="List all chats",
            tags=["storage"],
            parameters=[
                {"name": "limit", "in": "query", "required": False, "schema": {"type": "integer"}},
            ],
        )
        tool = gen._create_tool_metadata("/v1/storage/chats", "get", spec, "storage")
        assert tool is not None
        assert "name" in tool
        assert tool["api_endpoint"] == "/v1/storage/chats"
        assert tool["http_method"] == "GET"
        assert tool["integration"] == "storage"
        assert "parameters" in tool
        assert "signature" in tool

    def test_endpoint_with_path_param(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(summary="Get chat", tags=["storage"])
        tool = gen._create_tool_metadata("/v1/storage/chats/{chat_id}", "get", spec, "storage")
        assert tool is not None
        assert tool["http_method"] == "GET"

    def test_complexity_simple(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(
            summary="Get item",
            tags=["test"],
            parameters=[{"name": "id", "schema": {"type": "string"}}],
        )
        tool = gen._create_tool_metadata("/v1/test/{id}", "get", spec, "test")
        assert tool["complexity"] == "simple"

    def test_complexity_moderate(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(
            summary="Search",
            tags=["test"],
            parameters=[
                {"name": f"p{i}", "schema": {"type": "string"}} for i in range(4)
            ],
        )
        tool = gen._create_tool_metadata("/v1/test/search", "get", spec, "test")
        assert tool["complexity"] == "moderate"

    def test_complexity_advanced(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(
            summary="Complex",
            tags=["test"],
            parameters=[
                {"name": f"p{i}", "schema": {"type": "string"}} for i in range(7)
            ],
        )
        tool = gen._create_tool_metadata("/v1/test/complex", "get", spec, "test")
        assert tool["complexity"] == "advanced"

    def test_tool_tags_include_integration(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(summary="Test", tags=["ocr"])
        tool = gen._create_tool_metadata("/v1/ocr/process", "post", spec, "ocr")
        assert "ocr" in tool["tags"]
        assert "backend_api" in tool["tags"]
        assert "aether" in tool["tags"]

    def test_tool_examples_format(self, tmp_path):
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(summary="Test", tags=["test"])
        tool = gen._create_tool_metadata("/v1/test/run", "post", spec, "test")
        assert any("computer." in e for e in tool["examples"])

    def test_description_fallback(self, tmp_path):
        """When description is empty, falls back to method + path."""
        gen = _make_generator(tmp_path)
        spec = {"tags": ["test"]}
        tool = gen._create_tool_metadata("/v1/test/run", "post", spec, "test")
        assert "POST /v1/test/run" in tool["description"]

    def test_non_common_path_param_inserted(self, tmp_path):
        """Non-common path params like 'profile_name' get included in tool name."""
        gen = _make_generator(tmp_path)
        spec = _make_endpoint_spec(summary="Get profile", tags=["profiles"])
        tool = gen._create_tool_metadata(
            "/v1/profiles/{profile_name}", "get", spec, "profiles"
        )
        assert tool is not None
        # The param 'profile_name' is not in common_id_params, so it should appear
        assert "profile_name" in tool["name"] or "profiles" in tool["name"]


# ─── _generate_categories (integration test) ────────────────────────────────


class TestGenerateCategories:
    """Tests for _generate_categories."""

    def test_skips_endpoints_without_is_agent_tool_flag(self, tmp_path):
        """Endpoints missing openapi_extra={'is_agent_tool': True} should be skipped."""
        spec = {
            "paths": {
                "/v1/internal/stuff": {
                    "get": _make_endpoint_spec(tags=["test"], is_agent_tool=False),
                }
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        categories = gen._generate_categories()
        assert categories == {}

    def test_skips_non_http_methods(self, tmp_path):
        """Methods like 'options', 'head' etc. should be skipped."""
        spec = {
            "paths": {
                "/v1/test": {
                    "options": _make_endpoint_spec(tags=["test"]),
                    "head": _make_endpoint_spec(tags=["test"]),
                }
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        categories = gen._generate_categories()
        assert categories == {}

    def test_skips_endpoints_without_tags(self, tmp_path):
        spec = {
            "paths": {
                "/v1/notags": {
                    "get": _make_endpoint_spec(tags=[]),
                }
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        categories = gen._generate_categories()
        assert categories == {}

    def test_skips_disabled_integrations(self, tmp_path):
        spec = {
            "paths": {
                "/v1/ocr/process": {
                    "post": _make_endpoint_spec(tags=["ocr"]),
                }
            }
        }
        integrations = {
            "ocr": {"enabled": False, "description": "OCR"},
        }
        gen = _make_generator(tmp_path, openapi_spec=spec, integrations=integrations)
        categories = gen._generate_categories()
        assert categories == {}

    def test_enabled_integration_creates_category(self, tmp_path):
        spec = {
            "paths": {
                "/v1/ocr/process": {
                    "post": _make_endpoint_spec(
                        summary="Process OCR",
                        tags=["ocr"],
                    ),
                }
            }
        }
        integrations = {
            "ocr": {
                "enabled": True,
                "description": "OCR service",
                "layer3_metadata": {"category": "ocr", "requires_service": True},
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec, integrations=integrations)
        categories = gen._generate_categories()
        assert len(categories) > 0
        # Should be categorized under "Document Processing" (ocr → Document Processing)
        cat = list(categories.values())[0]
        assert len(cat["tools"]) == 1
        assert cat["integration"] == "ocr"

    def test_unknown_tag_creates_dynamic_config(self, tmp_path):
        """Tag not in registry → dynamically creates config."""
        spec = {
            "paths": {
                "/v1/custom/endpoint": {
                    "get": _make_endpoint_spec(
                        summary="Custom endpoint",
                        tags=["custom_service"],
                    ),
                }
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec)
        categories = gen._generate_categories()
        assert len(categories) > 0

    def test_skips_tool_when_create_metadata_returns_falsy(self, tmp_path):
        """Line 209: _create_tool_metadata returns falsy → tool skipped."""
        spec = {
            "paths": {
                "/v1/ocr/process": {
                    "post": _make_endpoint_spec(summary="Process", tags=["ocr"]),
                }
            }
        }
        integrations = {
            "ocr": {
                "enabled": True,
                "description": "OCR",
                "layer3_metadata": {"category": "ocr"},
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec, integrations=integrations)
        with patch.object(gen, "_create_tool_metadata", return_value=None):
            categories = gen._generate_categories()
        assert categories == {}

    def test_multiple_tools_in_same_category(self, tmp_path):
        spec = {
            "paths": {
                "/v1/tts/synthesize": {
                    "post": _make_endpoint_spec(summary="Synthesize", tags=["tts"]),
                },
                "/v1/tts/voices": {
                    "get": _make_endpoint_spec(summary="List voices", tags=["tts"]),
                },
            }
        }
        integrations = {
            "tts": {
                "enabled": True,
                "description": "TTS",
                "layer3_metadata": {"category": "tts"},
            }
        }
        gen = _make_generator(tmp_path, openapi_spec=spec, integrations=integrations)
        categories = gen._generate_categories()
        # Both should land in "Text-to-Speech"
        tts_cat = categories.get("Text-to-Speech")
        assert tts_cat is not None
        assert len(tts_cat["tools"]) == 2


# ─── _generate_integration_info ──────────────────────────────────────────────


class TestGenerateIntegrationInfo:
    """Tests for _generate_integration_info."""

    def test_enabled_integrations_only(self, tmp_path):
        integrations = {
            "ocr": {
                "enabled": True,
                "type": "service",
                "description": "OCR",
                "priority": 1,
                "layer3_metadata": {
                    "category": "ocr",
                    "tool_count": 3,
                    "requires_service": True,
                    "service_url": "http://localhost:8080",
                },
                "layer4_runtime": {"namespace": "computer"},
            },
            "disabled_one": {"enabled": False, "type": "library"},
        }
        gen = _make_generator(tmp_path, integrations=integrations)
        info = gen._generate_integration_info()
        assert "ocr" in info
        assert "disabled_one" not in info
        assert info["ocr"]["type"] == "service"
        assert info["ocr"]["priority"] == 1
        assert info["ocr"]["tool_count"] == 3
        assert info["ocr"]["requires_service"] is True
        assert info["ocr"]["api_prefix"] == "/v1/ocr"

    def test_no_enabled_integrations(self, tmp_path):
        integrations = {
            "a": {"enabled": False},
            "b": {"enabled": False},
        }
        gen = _make_generator(tmp_path, integrations=integrations)
        info = gen._generate_integration_info()
        assert info == {}

    def test_missing_layer3_layer4_uses_defaults(self, tmp_path):
        integrations = {
            "simple": {"enabled": True, "type": "library", "description": "Simple"},
        }
        gen = _make_generator(tmp_path, integrations=integrations)
        info = gen._generate_integration_info()
        assert info["simple"]["category"] == ""
        assert info["simple"]["tool_count"] == 0
        assert info["simple"]["namespace"] == "computer"


# ─── generate_backend_tools_yaml (module-level) ─────────────────────────────


class TestGenerateBackendToolsYamlFunction:
    """Tests for the module-level generate_backend_tools_yaml convenience function."""

    def test_happy_path(self, tmp_path):
        _write_registry(tmp_path)
        settings = _make_settings(config_dir=tmp_path)
        app = _make_app()
        output = tmp_path / "output.yaml"
        result = generate_backend_tools_yaml(app, settings, output_path=output)
        assert result is True
        assert output.exists()

    def test_default_output_path(self, tmp_path):
        _write_registry(tmp_path)
        settings = _make_settings(config_dir=tmp_path)
        app = _make_app()
        result = generate_backend_tools_yaml(app, settings, output_path=None)
        assert result is True
        expected_path = tmp_path / "backend_tools_registry.yaml"
        assert expected_path.exists()

    def test_exception_returns_false(self, tmp_path):
        settings = _make_settings(config_dir=tmp_path)
        # App that raises on openapi()
        app = MagicMock()
        app.openapi.side_effect = RuntimeError("Kaboom")
        result = generate_backend_tools_yaml(app, settings, output_path=tmp_path / "out.yaml")
        assert result is False

    def test_outer_exception_when_settings_none_and_no_output_path(self, tmp_path):
        """Lines 750-752: settings=None + output_path=None → AttributeError
        on settings.config_dir escapes inner handlers, caught by outer except."""
        app = MagicMock()
        result = generate_backend_tools_yaml(app, None)
        assert result is False


# ─── End-to-End Generation ──────────────────────────────────────────────────


class TestEndToEnd:
    """Full pipeline: OpenAPI → YAML with all sections populated."""

    def test_full_pipeline(self, tmp_path):
        spec = {
            "paths": {
                "/v1/ocr/process": {
                    "post": _make_endpoint_spec(
                        summary="Process document",
                        description="Run OCR on a document",
                        tags=["ocr"],
                        parameters=[
                            {
                                "name": "format",
                                "in": "query",
                                "required": False,
                                "schema": {"type": "string", "default": "markdown"},
                                "description": "Output format",
                            }
                        ],
                        request_body={
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {
                                            "file_data": {"type": "string"},
                                        },
                                        "required": ["file_data"],
                                    }
                                }
                            }
                        },
                    ),
                },
                "/v1/tts/voices": {
                    "get": _make_endpoint_spec(summary="List voices", tags=["tts"]),
                },
                "/docs": {
                    "get": _make_endpoint_spec(summary="Docs", tags=["internal"], is_agent_tool=False),
                },
                "/v1/health": {
                    "get": _make_endpoint_spec(summary="Health", tags=["health"], is_agent_tool=False),
                },
            },
            "components": {"schemas": {}},
        }
        integrations = {
            "ocr": {
                "enabled": True,
                "description": "OCR APIs",
                "layer3_metadata": {"category": "ocr", "requires_service": True, "service_url": "http://localhost:8080"},
                "layer4_runtime": {"namespace": "computer"},
            },
            "tts": {
                "enabled": True,
                "description": "TTS APIs",
                "layer3_metadata": {"category": "tts"},
                "layer4_runtime": {"namespace": "computer"},
            },
        }

        output = tmp_path / "result.yaml"
        gen = _make_generator(
            tmp_path,
            openapi_spec=spec,
            integrations=integrations,
            app_version="3.0.0",
            base_url="http://aether.local:8765",
        )
        result = gen.generate_yaml(output)
        assert result is True

        with open(output) as f:
            data = yaml.safe_load(f)

        # Metadata
        assert data["metadata"]["backend_version"] == "3.0.0"
        assert data["metadata"]["total_integrations"] == 2
        assert data["metadata"]["enabled_integrations"] == 2

        # Categories — /docs and /v1/health should be skipped
        categories = data["categories"]
        all_tools = []
        for cat in categories.values():
            all_tools.extend(cat["tools"])
        endpoints = [t["api_endpoint"] for t in all_tools]
        assert "/docs" not in endpoints
        assert "/v1/health" not in endpoints
        assert "/v1/ocr/process" in endpoints
        assert "/v1/tts/voices" in endpoints

        # Integration info
        assert "ocr" in data["integration_info"]
        assert "tts" in data["integration_info"]
        assert data["integration_info"]["ocr"]["api_prefix"] == "/v1/ocr"
