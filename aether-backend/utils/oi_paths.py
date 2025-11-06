"""Utilities for locating the bundled Open Interpreter sources.

@.architecture
Incoming: core/runtime/interpreter.py, Backend initialization --- {Path(__file__) for relative path calculation}
Processing: candidate_open_interpreter_paths(), resolve_open_interpreter_path() --- {2 jobs: path_resolution, path_validation}
Outgoing: core/runtime/interpreter.py --- {List[Path] candidate paths, Optional[Path] resolved path}
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional


def candidate_open_interpreter_paths() -> List[Path]:
    """Return possible locations of the in-repo Open Interpreter package.

    Preference order:
    1. `AetherArena/aether-backend/services/open-interpreter` (production location)
    2. `backend/open-interpreter` (old backend location - for backward compatibility)
    3. Top-level `open-interpreter` directory (legacy fallback)
    """

    # Current file is in AetherArena/aether-backend/utils/
    aether_backend_dir = Path(__file__).resolve().parent.parent
    # aether_backend_dir is now: /path/to/AetherArena/aether-backend
    
    # Go up one level to AetherArena/
    aether_arena_dir = aether_backend_dir.parent
    
    # Go up one more level to project root (contains AetherArena and backend)
    repo_root = aether_arena_dir.parent
    
    return [
        # PRODUCTION LOCATION: AetherArena/aether-backend/services/open-interpreter
        aether_backend_dir / "services" / "open-interpreter",
        # Old backend location (for backward compatibility): backend/open-interpreter
        repo_root / "backend" / "open-interpreter",
        # Legacy top-level location: open-interpreter/
        repo_root / "open-interpreter",
    ]


def resolve_open_interpreter_path() -> Optional[Path]:
    """Return the first existing Open Interpreter path, if any."""

    for path in candidate_open_interpreter_paths():
        if path.exists():
            return path
    return None


