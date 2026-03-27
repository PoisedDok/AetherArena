# Features

## User-facing capabilities

- **Streaming chat** with backend-managed model routing and persisted conversation state
- **On-device inference** through Aether Inference, with local backends such as MLX, vLLM, and `llama.cpp`
- **Tool-backed workflows** including code execution, search, document handling, and profile-specific agent behavior
- **Artifacts and trails** so generated outputs can be inspected, revisited, and traced
- **Document processing** through the Docling integration path
- **Web and local retrieval** through the Docker mesh and local indexing components
- **Proactive notifications** driven by daemon-collected activity and scout decisions
- **Settings and profiles** managed through the backend settings surface instead of hardcoded UI state
- **Export paths** for research-style results and generated content

## Platform capabilities behind those features

- **Central settings flow** through `/v1/settings/` and backend-owned configuration sources
- **Docker mesh services** for search, persistence, and cache
- **Independent daemons** for background activity capture and indexing
- **Security boundaries** across Electron, backend validation, process isolation, and container isolation
- **Feedback persistence** for proactive runs and later retrieval of similar cases

For architectural detail, use `docs/architecture/system-architecture.md` and `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md` instead of expanding this list into another implementation map.
