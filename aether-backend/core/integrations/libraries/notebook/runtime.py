"""
Notebook Runtime Environment Helpers - Layer 1 Implementation

Provides Python runtime environment inspection and module management tools.

Features:
- sys.path manipulation
- Dynamic module importing
- Package discovery
- Module inspection
- Runtime environment queries

Production-ready with:
- Error handling
- Validation
- Safe operations
- Clear responses

@.architecture
Incoming: api/v1/endpoints/notebook.py, Open Interpreter --- {str module_name, str path, Dict import requests}
Processing: nb_sys_path_add(), nb_import_module(), nb_list_packages(), nb_search_modules(), nb_get_module_info() --- {5 jobs: dynamic_importing, module_discovery, module_inspection, package_discovery, sys_path_management}
Outgoing: api/v1/endpoints/notebook.py, Open Interpreter --- {Dict[str, Any] module info, List[str] packages, List[Path] sys.path}
"""

import builtins
import importlib
import importlib.util
import logging
import pkgutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger(__name__)


def nb_sys_path_add(path: str, prepend: bool = True) -> Dict[str, Any]:
    """
    Add a filesystem path to sys.path for module discovery.
    
    Args:
        path: Filesystem path to add
        prepend: If True, add to beginning (higher priority). If False, append.
        
    Returns:
        Dict with:
            - success: bool
            - path: str (normalized path)
            - sys_path_length: int
            - error: str (if failed)
    
    Example:
        nb_sys_path_add("/path/to/my/modules")
    """
    try:
        # Normalize path
        normalized_path = str(Path(path).resolve())
        
        if prepend:
            # Remove if already present, then add to beginning
            if normalized_path in sys.path:
                sys.path.remove(normalized_path)
            sys.path.insert(0, normalized_path)
            logger.debug(f"Prepended {normalized_path} to sys.path")
        else:
            # Append if not already present
            if normalized_path not in sys.path:
                sys.path.append(normalized_path)
                logger.debug(f"Appended {normalized_path} to sys.path")
        
        return {
            "success": True,
            "path": normalized_path,
            "sys_path_length": len(sys.path),
            "position": "prepended" if prepend else "appended"
        }
        
    except Exception as e:
        error_msg = f"nb_sys_path_add failed: {str(e)}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}


def nb_import(
    module: str,
    alias: Optional[str] = None,
    fromlist: Optional[List[str]] = None,
    add_to_builtins: bool = True,
    reload: bool = False
) -> Dict[str, Any]:
    """
    Import a Python module/package and optionally expose it globally.
    
    Args:
        module: Dotted module path (e.g., 'pandas', 'sklearn.model_selection')
        alias: Optional global name to bind (e.g., 'pd' for pandas)
        fromlist: Optional list of symbols to import from module
        add_to_builtins: If True, bind in builtins for global access
        reload: If True, reload module if already imported
        
    Returns:
        Dict with:
            - success: bool
            - injected: list of names added to builtins
            - module: dict with module info
            - error: str (if failed)
    
    Examples:
        # Import pandas as pd globally
        nb_import('pandas', alias='pd')
        
        # Import specific functions
        nb_import('math', fromlist=['sqrt', 'pi'])
        
        # Reload module
        nb_import('mymodule', reload=True)
    """
    try:
        # Import or reload module
        if reload and module in sys.modules:
            mod = importlib.reload(sys.modules[module])
            logger.debug(f"Reloaded module: {module}")
        else:
            mod = importlib.import_module(module)
            logger.debug(f"Imported module: {module}")
        
        injected = []
        
        # Optional alias for the module itself
        if alias and add_to_builtins:
            setattr(builtins, alias, mod)
            injected.append(alias)
            logger.debug(f"Bound {module} as {alias} in builtins")
        
        # Optional fromlist bindings
        if fromlist:
            for name in fromlist:
                try:
                    obj = getattr(mod, name)
                    if add_to_builtins:
                        setattr(builtins, name, obj)
                        injected.append(name)
                        logger.debug(f"Bound {module}.{name} in builtins")
                except AttributeError:
                    return {
                        "success": False,
                        "error": f"Symbol '{name}' not found in module '{module}'"
                    }
        
        # Module info
        module_info = {
            "name": getattr(mod, "__name__", module),
            "file": getattr(mod, "__file__", None),
            "package": getattr(mod, "__package__", None),
            "version": getattr(mod, "__version__", None),
        }
        
        return {
            "success": True,
            "injected": injected,
            "module": module_info
        }
        
    except ModuleNotFoundError:
        error_msg = f"Module '{module}' not found"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}
    except Exception as e:
        error_msg = f"nb_import failed: {str(e)}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}


def nb_import_from_path(
    module: str,
    path: str,
    alias: Optional[str] = None,
    add_to_builtins: bool = True,
    reload: bool = False
) -> Dict[str, Any]:
    """
    Import a module from a specific file path.
    
    Args:
        module: Module name to assign
        path: Path to .py file
        alias: Optional global alias
        add_to_builtins: If True, bind in builtins
        reload: If True, reload if already imported
        
    Returns:
        Dict with import results
    
    Example:
        nb_import_from_path('mymodule', '/path/to/mymodule.py', alias='mm')
    """
    try:
        # Load module from path
        spec = importlib.util.spec_from_file_location(module, path)
        if spec is None or spec.loader is None:
            return {"success": False, "error": f"Cannot load module from {path}"}
        
        mod = importlib.util.module_from_spec(spec)
        
        # Execute module
        spec.loader.exec_module(mod)
        
        # Add to sys.modules
        if reload or module not in sys.modules:
            sys.modules[module] = mod
            logger.debug(f"Loaded module {module} from {path}")
        
        # Optional binding
        injected = []
        if alias and add_to_builtins:
            setattr(builtins, alias, mod)
            injected.append(alias)
        
        module_info = {
            "name": module,
            "file": path,
            "version": getattr(mod, "__version__", None)
        }
        
        return {
            "success": True,
            "injected": injected,
            "module": module_info
        }
        
    except Exception as e:
        error_msg = f"nb_import_from_path failed: {str(e)}"
        logger.error(error_msg)
        return {"success": False, "error": error_msg}


def nb_list_sys_path() -> Dict[str, Any]:
    """
    List all paths in sys.path.
    
    Returns:
        Dict with:
            - paths: list of path strings
            - count: int
    """
    try:
        return {
            "paths": sys.path.copy(),
            "count": len(sys.path)
        }
    except Exception as e:
        error_msg = f"nb_list_sys_path failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}


def nb_list_installed(
    method: str = "metadata",
    search: Optional[str] = None,
    limit: Optional[int] = 500
) -> Dict[str, Any]:
    """
    List installed Python packages.
    
    Args:
        method: Discovery method:
            - 'metadata': Use importlib.metadata (fastest, most accurate)
            - 'pkgutil': Use pkgutil.iter_modules
            - 'pip': Use pip list command
        search: Optional substring filter on package name
        limit: Maximum results to return (default: 500)
        
    Returns:
        Dict with:
            - packages: list of package dicts
            - count: int
            - method: str (method used)
            - error: str (if failed)
    
    Example:
        # List all packages
        nb_list_installed()
        
        # Search for numpy-related packages
        nb_list_installed(search='numpy')
        
        # Use pip method
        nb_list_installed(method='pip')
    """
    try:
        packages = []
        query = (search or "").lower()
        
        if method == "metadata":
            try:
                from importlib import metadata
                
                for dist in metadata.distributions():
                    name = (
                        dist.metadata.get("Name") or
                        dist.metadata.get("Summary") or
                        dist.metadata.get("name") or
                        getattr(dist, "_name", None)
                    )
                    version = getattr(dist, "version", None) or dist.metadata.get("Version")
                    
                    if name and (not query or query in name.lower()):
                        packages.append({
                            "name": name,
                            "version": version
                        })
                        
            except Exception as e:
                logger.warning(f"Metadata method failed, falling back to pkgutil: {e}")
                method = "pkgutil"
        
        if method == "pkgutil":
            for module_info in pkgutil.iter_modules():
                name = module_info.name
                if not query or query in name.lower():
                    packages.append({
                        "name": name,
                        "is_package": bool(module_info.ispkg),
                        "location": getattr(module_info.module_finder, "path", None)
                    })
        
        if method == "pip":
            try:
                output = subprocess.check_output(
                    [sys.executable, "-m", "pip", "list", "--format", "json"],
                    stderr=subprocess.DEVNULL
                )
                import json
                pip_list = json.loads(output.decode("utf-8", errors="ignore"))
                
                for item in pip_list:
                    name = item.get("name", "")
                    if not query or query in name.lower():
                        packages.append({
                            "name": name,
                            "version": item.get("version")
                        })
            except Exception as e:
                error_msg = f"pip list failed: {str(e)}"
                logger.error(error_msg)
                return {"error": error_msg}
        
        # Apply limit
        if limit and len(packages) > limit:
            packages = packages[:limit]
        
        logger.debug(f"Listed {len(packages)} packages using {method} method")
        
        return {
            "packages": packages,
            "count": len(packages),
            "method": method,
            "truncated": limit is not None and len(packages) == limit
        }
        
    except Exception as e:
        error_msg = f"nb_list_installed failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}


def nb_search_importable(
    query: str,
    include_stdlib: bool = True,
    limit: Optional[int] = 200
) -> Dict[str, Any]:
    """
    Search for importable modules matching query.
    
    Args:
        query: Search string (substring match on module name)
        include_stdlib: Include standard library modules
        limit: Maximum results (default: 200)
        
    Returns:
        Dict with:
            - modules: list of matching module names
            - count: int
            - error: str (if failed)
    
    Example:
        # Find all modules with 'http' in name
        nb_search_importable('http')
    """
    try:
        query_lower = query.lower()
        matches = []
        
        # Search in pkgutil
        for module_info in pkgutil.iter_modules():
            if query_lower in module_info.name.lower():
                matches.append({
                    "name": module_info.name,
                    "is_package": bool(module_info.ispkg)
                })
                
                if limit and len(matches) >= limit:
                    break
        
        # Search in sys.modules if not enough matches
        if limit is None or len(matches) < limit:
            for module_name in sys.modules:
                if query_lower in module_name.lower():
                    if module_name not in [m["name"] for m in matches]:
                        matches.append({
                            "name": module_name,
                            "loaded": True
                        })
                        
                        if limit and len(matches) >= limit:
                            break
        
        logger.debug(f"Found {len(matches)} importable modules matching '{query}'")
        
        return {
            "modules": matches,
            "count": len(matches),
            "query": query
        }
        
    except Exception as e:
        error_msg = f"nb_search_importable failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}


def nb_module_info(module: str) -> Dict[str, Any]:
    """
    Get detailed information about an importable module.
    
    Args:
        module: Module name (e.g., 'pandas', 'os.path')
        
    Returns:
        Dict with:
            - module: str (module name)
            - found: bool
            - origin: str (file path)
            - loader: str
            - file: str
            - version: str
            - import_error: str (if import failed)
            - error: str (if query failed)
    
    Example:
        nb_module_info('pandas')
    """
    try:
        info = {"module": module}
        
        # Find module spec
        spec = importlib.util.find_spec(module)
        info["found"] = spec is not None
        
        if spec is not None:
            info["origin"] = getattr(spec, "origin", None)
            info["loader"] = str(getattr(spec, "loader", None))
            
            # Try importing to get more info
            try:
                mod = importlib.import_module(module)
                info["file"] = getattr(mod, "__file__", None)
                info["version"] = getattr(mod, "__version__", None)
                info["package"] = getattr(mod, "__package__", None)
                info["doc"] = getattr(mod, "__doc__", None)
                
                # Get module attributes
                if hasattr(mod, "__all__"):
                    info["exports"] = getattr(mod, "__all__")
                
            except Exception as e:
                info["import_error"] = str(e)
                logger.warning(f"Could not import {module}: {e}")
        
        logger.debug(f"Retrieved info for module: {module}")
        return info
        
    except Exception as e:
        error_msg = f"nb_module_info failed: {str(e)}"
        logger.error(error_msg)
        return {"error": error_msg}

