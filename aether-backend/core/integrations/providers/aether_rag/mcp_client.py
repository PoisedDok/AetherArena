"""
@.architecture
Incoming: core/runtime/engine.py, interpreter.computer, config.settings --- {Dict settings, str server_name, Dict search params}
Processing: ensure_aether_rag_registered(), aether_rag_list(), aether_rag_search() --- {JOB_INITIALIZE_COMPONENT, JOB_ROUTE}
Outgoing: core/mcp/manager.MCPServerManager --- {Dict[str, Any] registration status, List[Dict] tools, str results}
"""

import sys
from pathlib import Path
from typing import Any, Dict, List

from core.mcp.context import get_mcp_manager
from config.settings import get_settings
from uuid import UUID


async def ensure_aether_rag_registered(server_name: str = "file_indexing_mcp", auto_start: bool = True) -> Dict[str, Any]:
	"""
	Ensure the File Indexing MCP server is registered with the MCP manager.
	"""
	manager = get_mcp_manager()
	if manager is None:
		return {"ok": False, "error": "MCP manager not initialized"}

	settings = get_settings()
	command = getattr(settings.integrations, "aether_rag_mcp_command", sys.executable)
	args: List[str] = list(getattr(settings.integrations, "aether_rag_mcp_args", []))
	
	# If args are empty, use default script path.
	# Path: services/daemons/mcp/file_indexing_mcp_server.py (relative to backend root).
	# In production: use AETHER_BACKEND_ROOT (writable data directory).
	# In dev: use Path(__file__) relative resolution.
	if not args:
		import os
		backend_root_env = os.environ.get("AETHER_BACKEND_ROOT")
		if backend_root_env:
			mcp_server_path = Path(backend_root_env) / "services" / "daemons" / "file_indexing" / "mcp_server.py"
		else:
			mcp_server_path = Path(__file__).parent.parent.parent.parent.parent / "services" / "daemons" / "file_indexing" / "mcp_server.py"
		args = [str(mcp_server_path.resolve())]

	env: Dict[str, str] = {}
	
	# Pass backend URL if configured (required for MCP server to talk to API)
	backend_url = getattr(settings.integrations, "file_indexing_backend_url", None) or settings.base_url
	if backend_url:
		env["INTEGRATION_FILE_INDEXING_BACKEND_URL"] = backend_url

	desired_config = {"command": command, "args": args, "env": env}

	# Enforce centralized settings without destroying server identity/tool cache.
	existing = await manager.get_server(server_name)
	if existing:
		existing_id = existing.get("id")
		existing_config = existing.get("config") if isinstance(existing.get("config"), dict) else {}

		needs_update = (
			existing_config.get("command") != desired_config.get("command")
			or list(existing_config.get("args") or []) != list(desired_config.get("args") or [])
		)

		if needs_update and existing_id:
			await manager.update_server(
				UUID(str(existing_id)),
				config=desired_config,
				auto_start=auto_start,
				enabled=True,
			)
		# Only start if requested and not already running.
		# IMPORTANT: start_server_by_name will restart if already running, which is disruptive and
		# can amplify cancellation/race issues during system startup.
		if auto_start and not bool(existing.get("is_running")):
			await manager.start_server_by_name(server_name)
		# Return fresh record after any updates
		refreshed = await manager.get_server(server_name)
		return {"ok": True, "server": refreshed or existing}

	# Not registered yet: register and optionally start.
	server_record = await manager.register_server(
		name=server_name,
		display_name="File Indexing MCP",
		server_type="local",
		config=desired_config,
		description="Search indexed files using semantic file search",
		auto_start=auto_start,
		enabled=True,
	)
	return {"ok": True, "server": server_record}


async def aether_rag_list(server_name: str = "file_indexing_mcp") -> Any:
	"""
	List available AETHER-RAG indexes from the local AETHER-RAG MCP server.

	NOTE: This calls the MCP tool named `aether_rag_list` (index discovery), not the MCP manager's
	internal tool-cache listing.
	"""
	manager = get_mcp_manager()
	if manager is None:
		return []

	ensure = await ensure_aether_rag_registered(server_name=server_name, auto_start=True)
	if not ensure.get("ok"):
		return {"success": False, "error": ensure.get("error") or "Failed to ensure AETHER-RAG MCP server"}

	server = await manager.get_server(server_name)
	if not server:
		return {"success": False, "error": "AETHER-RAG MCP server not available"}
	server_id = server["id"]

	# Execute the actual AETHER-RAG MCP tool to list indexes
	return await manager.execute_tool(server_id, "aether_rag_list", {})


async def aether_rag_search(
	index_name: str,
	query: str,
	top_k: int = 5,
	server_name: str = "file_indexing_mcp",
	complexity: int = 32,
	show_metadata: bool = False,
) -> Any:
	"""
	Execute a AETHER-RAG semantic search via the AETHER-RAG MCP tool.
	"""
	manager = get_mcp_manager()
	if manager is None:
		return {"success": False, "error": "MCP manager not initialized"}

	ensure = await ensure_aether_rag_registered(server_name=server_name, auto_start=True)
	if not ensure.get("ok"):
		return {"success": False, "error": ensure.get("error") or "Failed to ensure AETHER-RAG MCP server"}

	server = await manager.get_server(server_name)
	if not server:
		return {"success": False, "error": "AETHER-RAG MCP server not available"}
	server_id = server["id"]
	tool_args = {
		"index_name": index_name,
		"query": query,
		"top_k": top_k,
		"complexity": complexity,
		"show_metadata": show_metadata,
	}
	return await manager.execute_tool(server_id, "aether_rag_search", tool_args)


