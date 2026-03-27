"""
Compatibility shim: `xlwings.reports` historically mapped to `xlwings.pro.reports`.

AetherArena does **not** ship xlwings PRO material. This module remains so any
accidental imports fail fast with a clear message instead of a confusing
missing-module error from deep inside the package.
"""

def __getattr__(name: str):
    raise ImportError(
        "xlwings Reports (xlwings PRO) is not shipped with AetherArena. "
        "Remove usage of `xlwings.reports` / `xlwings.pro.*` or provide xlwings PRO "
        "via a separately-licensed external install."
    )

__all__ = ()
