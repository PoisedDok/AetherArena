# System Architecture

This document is the high-level topology reference. For file-level ownership and module lists, use `aether-backend/.architecture/backend_manifest.yaml` and `aether-frontend/.architecture/frontend_manifest.yaml`.

## Runtime components

### Electron desktop app

- **Main process**: window lifecycle, OS integration, shortcuts, secure defaults, IPC routing
- **Preload layer**: least-privilege bridge exposed through validated `contextBridge` APIs
- **Renderer windows**: user-facing UI for the main shell, chat workflows, and artifact views

### Python backend

- **HTTP API**: 37 route modules defining 237 HTTP routes under `api/v1/endpoints/`
- **WebSocket hub**: streaming chat output, trails, artifacts, audio control, and proactive notifications
- **Workers**: long-running backend tasks such as the proactive worker and monitoring jobs
- **Daemons**: independent background processes for browser, email, filesystem, query generation, and file indexing

### Aether Inference

- **External port**: `7090`
- **Backends**: MLX, vLLM, and `llama.cpp`
- **Behavior**: OpenAI-compatible API, lazy model loading, idle eviction after 600 seconds, 60-second reaper loop

### Docker service mesh

The mesh is defined in `aether-backend/services/external-services/docker-compose.yml`.

- **SearXNG**: `127.0.0.1:4040`
- **Perplexica**: `127.0.0.1:3000`, built locally with `pull_policy: never`
- **Supabase API gateway (Kong)**: `127.0.0.1:54321`
- **Supabase PostgreSQL**: `127.0.0.1:55432`
- **Redis**: `127.0.0.1:6379`
- **Network**: `aether-mesh-network`

## Persistence and contracts

- **PostgreSQL / Supabase**: chats, messages, artifacts, trails, jobs, proactive runs, user settings
- **SQLite**: daemon-local storage for browser, email, filesystem, and query-generation data
- **pgvector**: `vector(384)` embeddings for proactive feedback retrieval
- **BM25 indexes**: local retrieval indexes for daemon-collected activity
- **Contracts**: shared payload definitions live under `contracts/*.schema.json`

## Communication paths

- **Renderer -> Preload -> Main**: tightly controlled desktop IPC
- **Frontend -> Backend (HTTP)**: settings, CRUD flows, non-stream requests
- **Frontend <-> Backend (WebSocket)**: streaming chat, trails, artifact events, proactive notifications
- **Backend -> Aether Inference**: local model inference over HTTP on `:7090`
- **Backend -> Docker mesh**: search, AI search, database, cache, auth-related services
- **Daemons -> SQLite**: local-first logging without network dependency
- **Daemons -> Query generation**: signal files under `/tmp` coordinate proactive ingestion

## Ownership rules

- **Frontend owns UI**. Presentation state, window behavior, and renderer coordination stay in Electron code.
- **Backend owns orchestration**. Persistence, agent execution, service integration, and runtime policy stay in Python.
- **Backend settings are canonical**. The frontend reads runtime defaults from `/v1/settings/` instead of hardcoding service state.
- **Validate at boundaries**. IPC, HTTP, and WebSocket inputs should fail early when contracts are wrong.
- **Keep daemons independent**. Activity collection continues even if the backend restarts.
- **Do not duplicate internals here**. Proactive pipeline mechanics belong in `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md`.
