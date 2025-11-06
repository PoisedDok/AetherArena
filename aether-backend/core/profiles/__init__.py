"""
Profile Management System

Provides:
- ProfileManager: Profile discovery and loading
- ProfileEnricher: Tool discovery injection

Usage:
    from core.profiles import ProfileManager, ProfileEnricher
    
    # Discover profiles
    manager = ProfileManager()
    profiles = manager.discover_profiles()
    
    # Enrich profile with tool discovery
    enricher = ProfileEnricher(interpreter)
    enricher.inject_profile_tools("GURU", strategy="brief")
"""

from .manager import ProfileManager
from .enrichment import ProfileEnricher

__all__ = [
    "ProfileManager",
    "ProfileEnricher",
]

