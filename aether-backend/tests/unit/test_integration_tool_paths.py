import yaml
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.integrations.framework.loader import IntegrationLoader


def _resolve_tool_path(computer, tool_path: str):
    parts = tool_path.split(".")
    if not parts or parts[0] != "computer":
        raise ValueError(f"Invalid tool path: {tool_path}")
    obj = computer
    for part in parts[1:]:
        obj = getattr(obj, part)
    return obj


@pytest.mark.unit
def test_integration_registry_tool_paths_resolve():
    registry_path = Path(__file__).resolve().parents[2] / "config" / "integrations_registry.yaml"
    assert registry_path.exists()
    registry = yaml.safe_load(registry_path.read_text()) or {}
    integrations = registry.get("integrations", {})

    interpreter = SimpleNamespace(max_output=4000)
    interpreter.computer = SimpleNamespace()
    loader = IntegrationLoader(interpreter)
    loader.load_all()

    missing = []
    for name, config in integrations.items():
        if not config.get("enabled", True):
            continue
        tools_ref = config.get("tools_reference", {})
        for tool_path in tools_ref.get("tool_paths", []):
            try:
                tool = _resolve_tool_path(interpreter.computer, tool_path)
                if tool is None:
                    missing.append(tool_path)
            except Exception:
                missing.append(tool_path)

    assert not missing, f"Missing tool paths: {missing[:10]}"

