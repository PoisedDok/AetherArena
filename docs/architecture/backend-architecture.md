# Backend Architecture

## Ownership

The backend owns:

- orchestration of chats, tools, agents, and proactive workflows
- persistence across PostgreSQL and daemon-local SQLite databases
- HTTP and WebSocket boundary validation
- integration with Aether Inference, Docker-mesh services, and in-process libraries
- daemon lifecycle control, health checks, monitoring, and runtime policy

The backend does not own renderer state or UI presentation rules.

## Canonical structure

For exact file ownership, use `aether-backend/.architecture/backend_manifest.yaml`. At a high level, the backend is split into these runtime surfaces:

- **API layer**: `api/v1/` request handlers, schemas, middleware, and dependency wiring
- **WebSocket hub**: `ws/` streaming lifecycle, trail emission, audio control, and cancellation
- **Application layer**: `application/` orchestration services and domain-facing coordinators
- **Workers**: `workers/` background handlers such as the proactive worker
- **Integrations and runtime**: `core/` and `services/` adapters for search, parsing, inference, notebook execution, MCP, and daemons
- **Persistence**: `data/` repositories, migrations, and persistence gateways
- **Configuration and monitoring**: `config/`, `monitoring/`, and middleware-level policy enforcement

## Lifecycle

- **Startup**: load settings, build the FastAPI app, register middleware and routes, initialize persistence, wire the WebSocket hub, and start optional managed services such as Aether Inference and the daemon manager
- **Runtime**: serve HTTP and WebSocket traffic, refresh runtime settings, and let workers and daemons run on their own schedules
- **Shutdown**: close app-managed resources cleanly; independent daemons are designed to survive backend restarts where configured

## Configuration flow

Backend configuration is layered, with the backend remaining the canonical source for runtime defaults:

1. `config/settings.py` loads the typed settings model
2. `config/models.toml` carries model and provider defaults
3. `config/dynamic_settings.py` applies validated runtime overrides for integrations
4. `application/settings/runtime_settings_service.py` merges defaults with persisted user preferences

The frontend consumes that merged view through:

- `GET /v1/settings/`
- `POST /v1/settings/`

## Persistence model

- **Supabase / PostgreSQL** stores primary product data such as chats, artifacts, settings, jobs, and proactive runs
- **SQLite** stores daemon-collected local activity and generated proactive queries
- **Contracts** under `contracts/*.schema.json` define shared payload shapes across frontend and backend boundaries

## Design rules

- Keep orchestration in the backend and presentation in the frontend.
- Treat settings and integration URLs as backend-owned runtime state.
- Reject invalid inputs at the HTTP or WebSocket boundary instead of compensating later.
- Let adapters talk to external systems; keep route handlers thin.
