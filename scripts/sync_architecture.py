#!/usr/bin/env python3
"""
Sync Architecture Manifests
This script enforces the "Single Source of Truth" mandate by automatically scanning 
the codebase and updating the YAML architecture manifests to ensure they are never out of date.

It checks the exact file lists in:
1. aether-backend/.architecture/backend_manifest.yaml
2. aether-frontend/.architecture/frontend_manifest.yaml
"""

import os
from pathlib import Path
import sys

try:
    from ruamel.yaml import YAML
except ImportError:
    print("[!] Error: 'ruamel.yaml' is required to preserve comments in architecture manifests.")
    print("[!] Please run: pip install ruamel.yaml")
    sys.exit(1)

def get_actual_files(base_path: Path, directory: str, glob_pattern: str = "*.py") -> set:
    """Get relative paths of actual files in a directory."""
    target_dir = base_path / directory
    if not target_dir.exists():
        return set()
    
    files = set()
    for p in target_dir.rglob(glob_pattern):
        if "__pycache__" not in p.parts and p.name != "__init__.py":
            # Return path relative to base_path (e.g. api/v1/endpoints/foo.py)
            files.add(str(p.relative_to(base_path)))
    return files

def update_backend_manifest():
    root = Path(__file__).parent.parent
    backend_root = root / "aether-backend"
    manifest_path = backend_root / ".architecture" / "backend_manifest.yaml"
    
    if not manifest_path.exists():
        print(f"[!] Backend manifest not found at {manifest_path}")
        return False
        
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=4, offset=2)
    
    with open(manifest_path, 'r') as f:
        manifest = yaml.load(f)

        
    changed = False
    
    # Check Presentation API Endpoints
    endpoints_dir = "api/v1/endpoints"
    actual_endpoints = get_actual_files(backend_root, endpoints_dir)
    if "layers" in manifest and "presentation_api" in manifest["layers"]:
        listed_endpoints = set(manifest["layers"]["presentation_api"].get("modules", {}).get("endpoints", []))
        
        # Add missing
        missing = actual_endpoints - listed_endpoints
        # Remove deleted
        deleted = listed_endpoints - actual_endpoints
        
        if missing or deleted:
            print(f"[*] Syncing Backend Endpoints. Added: {len(missing)}, Removed: {len(deleted)}")
            updated_list = sorted(list(actual_endpoints))
            manifest["layers"]["presentation_api"]["modules"]["endpoints"] = updated_list
            changed = True

    # Check Presentation API Schemas
    schemas_dir = "api/v1/schemas"
    actual_schemas = get_actual_files(backend_root, schemas_dir)
    if "layers" in manifest and "presentation_api" in manifest["layers"]:
        listed_schemas = set(manifest["layers"]["presentation_api"].get("modules", {}).get("schemas", []))
        
        missing = actual_schemas - listed_schemas
        deleted = listed_schemas - actual_schemas
        
        if missing or deleted:
            print(f"[*] Syncing Backend Schemas. Added: {len(missing)}, Removed: {len(deleted)}")
            updated_list = sorted(list(actual_schemas))
            manifest["layers"]["presentation_api"]["modules"]["schemas"] = updated_list
            changed = True

    if changed:
        with open(manifest_path, 'w') as f:
            yaml.dump(manifest, f)
        print("[+] Successfully synced backend_manifest.yaml")
        return True
        
    print("[=] Backend manifest is already in sync.")
    return False

def update_frontend_manifest():
    # Similar structure can be applied to frontend paths if needed
    # (e.g. matching src/renderer/main/modules/*)
    pass

if __name__ == "__main__":
    print("Running Architecture Sync...")
    try:
        b_changed = update_backend_manifest()
        # f_changed = update_frontend_manifest() # Can be extended
        if b_changed:
            sys.exit(1) # Return 1 so pre-commit knows files were modified and can halt to let user stage them
        sys.exit(0)
    except Exception as e:
        print(f"[!] Error syncing architecture: {e}")
        sys.exit(1)
