# Aether Frontend

Electron frontend for the AetherArena desktop runtime.

## What it contains

- `src/main/` — Electron main-process code
- `src/preload/` — preload boundary and IPC exposure
- `src/renderer/` — user-facing windows and shared renderer utilities
- `src/core/`, `src/domain/`, `src/application/`, `src/infrastructure/` — layered frontend architecture

Use `docs/architecture/frontend-architecture.md` for the maintained architecture summary.

## Local setup

```bash
cd aether-frontend
npm install
cp env.example .env
npm run dev
```

## Backend dependency

The frontend expects the backend on `http://localhost:8765` unless the environment overrides that default. Runtime service configuration comes from the backend settings surface rather than hardcoded UI assumptions.

## Useful commands

```bash
# Development
npm run dev

# Tests
npm test

# Build
npm run build
```

## Security stance

- renderers stay behind preload-managed IPC boundaries
- runtime content is sanitized before rendering
- frontend security utilities live under `src/core/security/`

## Related docs

- `scripts/README.md`
- `src/core/communication/README.md`
- `src/core/security/README.md`
- `src/domain/artifacts/README.md`

