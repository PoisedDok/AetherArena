# Operations

## Runtime components

- backend API and WebSocket service on port `8765`
- Electron frontend
- Docker mesh for search, persistence, and cache
- Aether Inference on port `7090`
- daemon manager for background activity and indexing services

## Local startup flow

### 1. Start the Docker mesh

```bash
cd aether-backend/services/external-services
docker compose up -d
```

### 2. Start the backend

```bash
cd aether-backend
bash start_production.sh
```

`start_production.sh` is a thin bootstrapper. It delegates to `main.py orchestrate` in source mode or to the bundled `aether-hub` binary when present.

### 3. Start the frontend

```bash
cd aether-frontend
npm run dev
```

## Docker mesh operations

```bash
cd aether-backend/services/external-services

# Health/status
docker compose ps

# Service logs
docker compose logs -f perplexica
docker compose logs -f searxng

# Rebuild Perplexica from the local service tree
docker compose up -d --build perplexica
```

Verified operational facts:

- Perplexica is built locally with `pull_policy: never`
- services join `aether-mesh-network`
- mesh environment comes from `services/external-services/.env`

## Daemon operations

The backend starts or adopts the daemon manager through `services/daemons/daemon_control.py`.

Operationally that means:

- daemons are backend-managed, but designed to survive backend restarts where configured
- config reloads are propagated through daemon-control logic rather than ad hoc manual restarts
- daemon data lives in local SQLite stores under `data/daemons/`

## Health and verification

Useful checks:

- `GET /health`
- `GET /v1/health`
- `GET /v1/services/status`
- `docker compose ps`

For API-level documentation and helper endpoints, use `docs/architecture/API_DOCUMENTATION.md`.

## Packaging

- the backend bundle is driven by `aether-backend/build-config.spec`
- `start_production.sh` can launch either the source backend or the bundled `aether-hub` binary, depending on what is present

## Operational expectations

- missing critical configuration should fail early
- unhealthy optional integrations should report as unavailable rather than corrupting state
- daemonized services and local stores should not require the frontend to stay open
