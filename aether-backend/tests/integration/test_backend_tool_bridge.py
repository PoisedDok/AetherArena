from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from app import create_app
from config.settings import get_settings
from core.integrations.framework.oi_catalog import OIToolCatalogBridge


def _resolve_tool_path(computer, tool_path: str):
    parts = tool_path.split(".")
    if not parts or parts[0] != "computer":
        raise ValueError(f"Invalid tool path: {tool_path}")
    obj = computer
    for part in parts[1:]:
        obj = getattr(obj, part)
    return obj


@pytest.mark.integration
def test_backend_tool_bridge_attaches_tools():
    app = create_app()
    settings = get_settings()
    bridge = OIToolCatalogBridge(app, settings)

    interpreter = SimpleNamespace(max_output=4000)
    interpreter.computer = SimpleNamespace()

    result = bridge.register_with_oi(interpreter)
    assert result.get("success") is True
    assert result.get("tools_attached", 0) > 0


@pytest.mark.integration
def test_backend_tool_registry_paths_resolve():
    registry_path = Path(__file__).resolve().parents[2] / "config" / "backend_tools_registry.yaml"
    assert registry_path.exists()
    registry = yaml.safe_load(registry_path.read_text()) or {}

    app = create_app()
    settings = get_settings()
    bridge = OIToolCatalogBridge(app, settings)

    interpreter = SimpleNamespace(max_output=4000)
    interpreter.computer = SimpleNamespace()
    bridge.register_with_oi(interpreter)

    missing = []
    categories = registry.get("categories", {})
    for cat_data in categories.values():
        for tool_def in cat_data.get("tools", []):
            tool_path = tool_def.get("path")
            if not tool_path:
                continue
            try:
                tool = _resolve_tool_path(interpreter.computer, tool_path)
                if tool is None:
                    missing.append(tool_path)
            except Exception:
                missing.append(tool_path)

    assert not missing, f"Missing backend tool paths: {missing[:10]}"

