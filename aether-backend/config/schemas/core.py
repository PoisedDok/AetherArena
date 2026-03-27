import json
import os
import sys
from pathlib import Path
from typing import List, Any

from pydantic_settings import BaseSettings

def _load_env_file(path: Path) -> None:
    """
    Load KEY=VALUE pairs into os.environ (fail-soft).

    We do this explicitly because this codebase uses Pydantic BaseModel (not BaseSettings),
    so env_prefix is metadata only unless we merge env vars ourselves.
    """
    try:
        if not path.exists():
            return
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if value and len(value) >= 2 and value[0] == value[-1] and value.startswith(('"', "'")):
                value = value[1:-1]
            if not key:
                continue
            # Do not override explicitly-set environment variables unless empty.
            existing = os.environ.get(key)
            if existing is None or existing == "":
                os.environ[key] = value
    except Exception:
        # Never fail import/startup due to local env file parsing.
        return


def _load_local_env_defaults() -> None:
    """
    Load local secrets/config for dev/test.

    Source of truth: `aether-backend/config/local.env`
    
    IMPORTANT: In packaged/frozen mode, we NEVER load from the bundle (sys._MEIPASS).
    The local.env file contains runtime-generated secrets that are shared with
    Docker containers. Loading from bundle would use stale, baked-in secrets.
    
    Loading priority (packaged mode):
    1. Next to executable (./local.env)
    2. In config/ next to executable (./config/local.env)
    
    Loading priority (dev mode):
    1. Backend root config/ directory (./config/local.env)
    """
    if getattr(sys, 'frozen', False):
        # PACKAGED MODE: Only load from filesystem, never from bundle
        # sys.executable is dist/aether-hub/aether-hub
        exe_dir = Path(sys.executable).parent
        cwd = Path.cwd()
        
        # Priority 0 (HIGHEST): AETHER_BACKEND_ROOT (writable data directory)
        # start_production.sh exports this to $DATA_DIR (~/Library/Application Support/Aether).
        # The local.env with generated secrets lives here, NOT next to the binary.
        backend_root_env = os.getenv("AETHER_BACKEND_ROOT")
        if backend_root_env:
            _load_env_file(Path(backend_root_env) / "config" / "local.env")
            _load_env_file(Path(backend_root_env) / "local.env")
        
        # Priority 1: Current Working Directory (standard for production scripts)
        _load_env_file(cwd / "config" / "local.env")
        _load_env_file(cwd / "local.env")

        # Priority 2: Next to executable (portable mode)
        _load_env_file(exe_dir / "local.env")
        _load_env_file(exe_dir / "config" / "local.env")
    else:
        # DEVELOPMENT MODE: Load from source tree
        this_dir = Path(__file__).resolve().parent
        # Note: core.py is in config/schemas/, so parent.parent is config/
        _load_env_file(this_dir.parent / "local.env")


def _parse_bool_env(raw: str) -> bool:
    """Parse strict boolean environment values."""
    v = (raw or "").strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    raise ValueError(f"Invalid boolean env value: {raw!r}")


def _parse_list_env(raw: str, env_name: str) -> List[str]:
    """Parse list env vars from JSON array or comma-separated string."""
    normalized = (raw or "").strip()
    if not normalized:
        return []

    if normalized.startswith("["):
        try:
            parsed = json.loads(normalized)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{env_name} must be a valid JSON array or comma-separated list") from exc
        if not isinstance(parsed, list):
            raise ValueError(f"{env_name} must resolve to a list")
        return [str(item).strip() for item in parsed if str(item).strip()]

    return [part.strip() for part in normalized.split(",") if part.strip()]


def _parse_json_list_env(raw: str, env_name: str) -> List[Any]:
    """Parse JSON list env vars (for structured security config)."""
    normalized = (raw or "").strip()
    if not normalized:
        return []

    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{env_name} must be a valid JSON list") from exc

    if not isinstance(parsed, list):
        raise ValueError(f"{env_name} must be a JSON list")
    return parsed


def get_app_root() -> Path:
    """
    Get the application root directory.
    - If AETHER_BACKEND_ROOT is set, use it (standard for production).
    - In frozen mode: The directory containing the executable (dist/aether-hub/)
    - In dev mode: The repository root (aether-backend/)
    """
    if env_root := os.getenv("AETHER_BACKEND_ROOT"):
        return Path(env_root).resolve()
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent.resolve()
    # Path(__file__) is aether-backend/config/schemas/core.py
    return Path(__file__).resolve().parents[2]


def get_bundle_root() -> Path:
    """
    Get the bundle root directory.
    - In frozen mode: The _internal directory (sys._MEIPASS)
    - In dev mode: The repository root (aether-backend/)
    """
    if getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS'):
        return Path(sys._MEIPASS).resolve()
    return Path(__file__).resolve().parents[2]


def get_install_root() -> Path:
    """
    Get the installation root directory (read-only in packaged mode).
    
    In packaged macOS/Linux apps, the app bundle (Resources/bin/) is READ-ONLY.
    This function returns that read-only installation path where binaries,
    services (Perplexica, external-services), and scripts live.
    
    - If AETHER_INSTALL_DIR is set: use it (set by start_production.sh / ServiceLauncher.js)
    - In frozen mode: The directory containing the executable
    - In dev mode: The repository root (same as get_app_root)
    """
    if env_install := os.getenv("AETHER_INSTALL_DIR"):
        return Path(env_install).resolve()
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent.resolve()
    return Path(__file__).resolve().parents[2]


# =============================================================================
# Inference Path Resolution (dev-mode fallback)
# =============================================================================

def _resolve_inference_venv(app_root: Path) -> Path:
    """Resolve venv-inference for dev mode.  In prod, env var is preferred."""
    candidates = [
        app_root / "venv-inference",
        Path.home() / "Library" / "Application Support" / "Aether" / "venv-inference",
    ]
    for c in candidates:
        if (c / "bin" / "python").exists():
            return c
    return candidates[0]


def _resolve_inference_models_dir(app_root: Path) -> Path:
    """Resolve inference models directory for dev mode.  In prod, env var is preferred."""
    candidates = [
        app_root / "models",
        Path.home() / "Library" / "Application Support" / "Aether" / "models",
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


class AetherBaseSettings(BaseSettings):
    """
    Base settings class ensuring priority:
    1. Environment variables (highest)
    2. TOML configuration (via init_settings)
    3. Model defaults (lowest)
    """
    @classmethod
    def settings_customise_sources(
        cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
    ):
        # Priority inversion: Env overrides TOML (passed as init kwargs)
        return (env_settings, init_settings)


def _parse_comma_list(v: any) -> list:
    if isinstance(v, str):
        if v.strip().startswith('['):
            import json
            try:
                return [str(x).strip() for x in json.loads(v) if str(x).strip()]
            except json.JSONDecodeError:
                pass
        return [x.strip() for x in v.split(",") if x.strip()]
    return v


def _parse_json_list(v: any) -> list:
    if isinstance(v, str):
        if not v.strip():
            return []
        import json
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            pass
    return v
