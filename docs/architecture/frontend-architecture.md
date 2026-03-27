# Frontend Architecture

## Ownership

The frontend owns:

- desktop window behavior and user workflows
- renderer state, presentation logic, and local interaction handling
- preload-mediated IPC boundaries
- client-side sanitization, rendering safety, and UI-level input constraints

The frontend does not own backend persistence rules, service orchestration, or system-wide runtime policy.

## Process model

- **Main process** (`src/main/`): creates and manages Electron windows, shortcuts, IPC routing, and OS integration
- **Preload layer** (`src/preload/`): exposes least-privilege APIs through validated `contextBridge` surfaces
- **Renderer layer** (`src/renderer/`): main shell, chat UI, artifact UI, and shared renderer utilities

## Layered structure

The maintained frontend follows a layered layout described in `aether-frontend/.architecture/frontend_manifest.yaml`:

- **Core** (`src/core/`): communication, configuration, events, dependency injection, security, session, shared utilities
- **Domain** (`src/domain/`): chat, artifacts, audio, settings, and trail-related business rules
- **Application** (`src/application/`): orchestration of chat, artifacts, settings, and main-window workflows
- **Infrastructure** (`src/infrastructure/`): backend adapters, IPC bridges, persistence, monitoring, caches
- **Renderer** (`src/renderer/`): user-facing presentation modules built on the layers above

## Backend integration

- HTTP clients fetch configuration, models, settings, storage data, and other non-stream resources
- WebSocket clients handle streaming chat output, trail updates, artifact events, and proactive notifications
- Runtime defaults come from the backend, especially `/v1/settings/`, instead of being hardcoded in the renderer
- Model metadata comes from backend endpoints such as `/v1/models` and `/v1/llm-providers/*`

## Security boundary

- Renderers do not receive raw Node.js privileges
- Preload scripts validate payloads and channel access before crossing into the main process
- Sanitization and safe rendering live in frontend security and renderer utilities, not in ad hoc component code

## Shared renderer support

Common helpers live under `src/renderer/shared/utils/` for formatting, export, DOM work, theme handling, accessibility, diagnostics, and renderer logging.
