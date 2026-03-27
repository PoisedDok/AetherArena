# AetherArena

AetherArena  
License  
Status  
**AI Desktop Application**

*Python backend orchestrating multiple AI services via Docker mesh • On-device inference • Proactive agent • Hardened security & privacy-first design*

[Quick Start](#quick-start) • [Documentation](#documentation) • [Contributing](#contributing)

---

## Current Status

> **RELEASED** (March 2026)
>
> AetherArena v1.0 is now available for macOS as a packaged DMG installer. The application includes all core subsystems: chat streaming, proactive agent pipeline, Docker service mesh, Aether Inference (on-device model routing), daemon-based activity monitoring, file indexing, and the Electron desktop frontend.
>
> **Download**: Available at [aetherinc.xyz](https://aetherinc.xyz)

## Overview

AetherArena is a privacy-first AI desktop application orchestrating local models and services:


| Proactive Agent                                  | Conversational AI                            | Code Execution                |
| ------------------------------------------------ | -------------------------------------------- | ----------------------------- |
| Anticipatory assistance from activity monitoring | Streaming chat with on-device & cloud models | Real-time artifact generation |



| Voice Integration               | Document Processing               | Web Search                                            |
| ------------------------------- | --------------------------------- | ----------------------------------------------------- |
| Speech-to-text & text-to-speech | Advanced OCR & analysis (Docling) | Privacy-respecting aggregation (SearXNG + Perplexica) |



| Excel Automation                        | File Indexing                                 | Security First                       |
| --------------------------------------- | --------------------------------------------- | ------------------------------------ |
| Live spreadsheet manipulation (xlwings) | Semantic search over local files (Aether-RAG) | Hardened security + daemon isolation |



| Aether Inference                                  | Multi-Service Mesh                               |
| ------------------------------------------------- | ------------------------------------------------ |
| On-device multi-model router (MLX/vLLM/llama.cpp) | Multiple AI services via Docker Compose orchestration |


## Architecture

### Architecture Reference

The full system architecture, module boundaries, and service mesh details are documented extensively in the dedicated architecture manifests and markdown files:

- **System Architecture:** `docs/architecture/system-architecture.md`
- **Backend Architecture Manifest:** `aether-backend/.architecture/backend_manifest.yaml`
- **Frontend Architecture Manifest:** `aether-frontend/.architecture/frontend_manifest.yaml`
- **Backend High-Level Overview:** `docs/architecture/backend-architecture.md`
- **Frontend High-Level Overview:** `docs/architecture/frontend-architecture.md`

*Note: You can auto-generate architecture indexes from inline `@.architecture` trace blocks by running the `job_tracer` scripts in the respective directories.*

## Technology Stack

### Backend

- **Python 3.9+**: Core runtime
- **FastAPI**: REST API framework (36 endpoint modules, 44 mounted `APIRouter`s in `api/v1/router.py`; 237 `@router` HTTP handlers under `api/` — OpenAPI lists more operations when each method binding is counted separately)
- **Perplexica (fork, TypeScript/Next.js)**: Proactive classifier, scout, and decision pipelines and related API routes under `aether-backend/services/perplexica/src/` (`lib/agents/proactive/`, `lib/prompts/proactive/`, `app/api/proactive/`, etc.)
- **WebSocket**: Real-time streaming (chat, trails, artifacts, proactive notifications)
- **PostgreSQL (Supabase)**: Primary database with pgvector for semantic search
- **SQLite**: Daemon-local storage (browser logs, email logs, filesystem logs, generated queries)
- **Redis**: Caching and session storage
- **Docker Compose**: Service mesh orchestration (`aether-mesh`)
- **MLX / vLLM / llama.cpp**: On-device model inference backends
- **Aether-RAG (FAISS-HNSW)**: Lightweight semantic search
- **PyTerrier**: BM25 indexing for daemon activity logs
- **LiteLLM**: Multi-provider LLM routing

### Frontend

- **Electron**: Desktop framework with context isolation
- **Node.js ≥18.0.0**: Runtime environment
- **Three.js**: 3D visualization (neural visualizer)
- **DOMPurify**: Content sanitization
- **Marked**: Markdown rendering
- **Ace Editor**: Code editing interface
- **Zod**: Schema validation
- **Clean Architecture**: Core → Domain → Application → Infrastructure → Renderer layers

### Security

- **Context Isolation**: Electron security boundary
- **Content Security Policy**: XSS prevention
- **IPC Validation**: Secure inter-process communication with whitelisted channels
- **Input Sanitization**: All user input filtered at boundaries
- **Permission Whitelisting**: Minimal Chromium permissions
- **Daemon Isolation**: Each daemon runs as independent process with PID locking
- **Container Isolation**: Docker services run in isolated network (`aether-mesh-network`)

## Quick Start

### Prerequisites

- Python 3.9+
- Node.js 18+
- Docker & Docker Compose (for service mesh: Supabase/PostgreSQL, SearXNG, Perplexica, Redis)

### Installation

1. **Clone the repository**
  ```bash
   git clone <repository-url>
   cd AetherArena
  ```
2. **Setup and Start Backend**
  ```bash
   cd aether-backend
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   # This will automatically generate config/local.env and start the Docker mesh
   bash start_production.sh
  ```
3. **Setup Frontend**
  ```bash
   cd ../aether-frontend
   npm install
   cp env.example .env
  ```
4. **Start Development Environment**
  ```bash
   # Terminal 1: Start backend
   cd aether-backend
   bash start_production.sh

   # Terminal 2: Start frontend
   cd aether-frontend
   npm run dev
  ```

## Configuration

### Backend Configuration

Central config in `aether-backend/config/`:

- `settings.py` — typed Settings model with env-var merge
- `models.toml` — model/provider/feature defaults
- `dynamic_settings.py` — validated runtime integration overrides

Runtime settings exposed via API:

- `GET /v1/settings/` — merged defaults + DB user preferences
- `POST /v1/settings/` — persist user preferences

### Docker Mesh Configuration

Service mesh secrets in `aether-backend/config/local.env` (auto-generated on first run):

- Supabase JWT secrets, database credentials
- SearXNG secret key
- Redis password (optional)

### Frontend Configuration

Environment variables in `aether-frontend/.env`:

```bash
# Backend
GURU_API_URL=http://localhost:8765
GURU_SPAWN_BACKEND=true

# Features
ENABLE_VOICE_INPUT=true
ENABLE_TTS=true
```

## Development

### Backend Development

```bash
cd aether-backend
pytest
uvicorn app:app --reload --host 0.0.0.0 --port 8765
```

### Frontend Development

```bash
cd aether-frontend
npm run dev
npm test
npm run build
```

### Testing Strategy

- **Unit Tests**: Individual component testing
- **Integration Tests**: Service interaction testing
- **E2E Tests**: Full user workflow testing
- **Security Tests**: Penetration testing and vulnerability scanning

## Security Features

- **Electron Hardening**: Context isolation, CSP, permission whitelisting
- **Input Validation**: Sanitization at all boundaries
- **IPC Security**: Whitelisted channels with payload schema validation
- **API Security**: JWT authentication, tiered rate limiting, CORS
- **Daemon Isolation**: Independent processes with PID file locking
- **Container Isolation**: Docker services in isolated network (`aether-mesh-network`)
- **Data Protection**: Secure key management, no hardcoded secrets

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes following clean architecture principles
4. Verify all tests pass: `npm test && pytest`
5. Submit a pull request

### Code Style

- **Python**: PEP 8 with Black formatting
- **JavaScript**: ESLint with Airbnb config
- **Documentation**: JSDoc for APIs, docstrings for Python

### Architecture Guidelines

- **Clean Architecture**: Strict separation of concerns
- **Dependency Injection**: Service management through DI container
- **Event-Driven**: Loose coupling through event bus
- **Repository Pattern**: Data access abstraction

## Documentation

- `manual.md` — evaluator-oriented build, run, and test instructions.
- `docs/` — maintained project documentation; start at `docs/index.md`.
- `docs/architecture/` — high-level system, backend, frontend, and API references.
- `aether-backend/services/README.md` — backend service map and integration overview.
- `aether-backend/scripts/README.md` and `aether-frontend/scripts/README.md` — job tracer and script usage.
- `aether-frontend/src/core/communication/README.md` — renderer/main-process communication notes.

## Status

**Current Status**: Released v1.0 (March 2026)


| Subsystem                                                  | Status   |
| ---------------------------------------------------------- | -------- |
| Backend API (FastAPI; 237 route handlers under `api/`)     | Released |
| Frontend (Electron, clean architecture)                    | Released |
| Docker Service Mesh (SearXNG, Perplexica, Supabase, Redis) | Released |
| Aether Inference (on-device model router)                  | Released |
| Proactive Agent (daemon pipeline + ReAct scouting + ICL)   | Released |
| File Indexing Daemon (Aether-RAG semantic search)          | Released |
| Chat streaming + trails + artifacts                        | Released |
| Settings system (central config, DB prefs)                 | Released |
| Document processing (Docling)                              | Released |
| Excel automation (xlwings)                                 | Released |
| TTS synthesis (RealtimeTTS)                                | Released |


**Download**: macOS DMG installer available at [aetherinc.xyz](https://aetherinc.xyz)

## License

This project is licensed under the **Business Source License 1.1 (BSL 1.1)**.

- **Non-Commercial Use**: Free for personal, testing, and development use.
- **Commercial Use**: Requires a commercial license from the Licensor.
- **Change Date**: On 2029-11-21, this release will automatically convert to **Apache License, Version 2.0**.

See the `LICENSE` file for details. Individual AI services and third-party components maintain their respective licenses.

## Open Source Acknowledgements

- **[Supabase](https://supabase.com)** (Apache 2.0 / MIT) - Open source Firebase alternative.
- **[xlwings](https://www.xlwings.org)** (BSD 3-Clause) - Python library for Excel automation.
- **[RealtimeTTS](https://github.com/KoljaB/RealtimeTTS)** (MIT) - Real-time text-to-speech engine.
- **[Docling](https://github.com/DS4SD/docling)** (MIT) - Advanced document parsing and processing.
- **[Perplexica](https://github.com/ItzCrazyKns/Perplexica)** (MIT) - AI-powered search engine.
- **OmniParser** (CC-BY 4.0) - Optional external dependency; Aether integrates screen tooling through `aether-backend/core/integrations/libraries/omni/`, but no OmniParser checkout is maintained as a first-party repo subtree here.
- **[SearXNG](https://github.com/searxng/searxng)** (AGPL-3.0-or-later) - Runtime dependency used through the Docker mesh; local configuration templates live under `aether-backend/services/external-services/volumes-template/searxng/`.
- **[Open Interpreter](https://github.com/OpenInterpreter/open-interpreter)** (AGPL-3.0-only) - Run as an external server when enabled; orchestration wrapper is `aether-backend/scripts/oi_server_wrapper.py`.
- **[Aether-RAG](https://github.com/yichuan-w/Aether-RAG)** (MIT) - Lightweight on-device semantic search.
- **[FastAPI](https://fastapi.tiangolo.com)** - Python API framework.
- **[Electron](https://www.electronjs.org)** - Desktop application framework.

## Links

- **Frontend README**: `aether-frontend/README.md`
- **Backend Services**: `aether-backend/services/README.md`
- **API Documentation**: Available at `/docs` when backend is running

---

**Built by Krish Dokania.** [Back to Top](#aetherarena)