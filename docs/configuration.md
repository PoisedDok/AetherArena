# Configuration

## Principles

- configuration should have a clear source of truth
- the backend owns runtime defaults
- the frontend should fetch runtime state instead of hardcoding service behavior
- deployment-specific secrets belong in environment-managed files, not in prose assumptions

## Backend configuration

The backend’s main configuration sources are:

- `aether-backend/config/settings.py`
- `aether-backend/config/models.toml`
- `aether-backend/config/dynamic_settings.py`
- `aether-backend/application/settings/runtime_settings_service.py`

Together they cover:

- service URLs and feature toggles
- model/provider defaults
- network and security settings
- proactive and daemon settings
- Aether Inference options

Runtime settings exposed to the frontend:

- `GET /v1/settings/`
- `POST /v1/settings/`

## Docker mesh configuration

The mesh lives in `aether-backend/services/external-services/docker-compose.yml`.

Verified externally exposed defaults:

- SearXNG: `127.0.0.1:4040`
- Perplexica: `127.0.0.1:3000`
- Supabase API gateway (Kong): `127.0.0.1:54321`
- PostgreSQL direct access: `127.0.0.1:55432`
- Redis: `127.0.0.1:6379`

The mesh reads its environment from `aether-backend/config/local.env`.

## Aether Inference configuration

Aether Inference is controlled through backend settings and server CLI options.

The verified defaults in the service code include:

- port `7090`
- localhost binding
- backend selection across MLX, vLLM, and `llama.cpp`
- idle eviction after 600 seconds

See `aether-backend/services/aether_inference/server.py` and `aether-backend/services/aether_inference/manager.py`.

## Proactive and daemon configuration

Proactive behavior is controlled through central settings plus runtime config reads used by the proactive services.

Important runtime-controlled categories include:

- daemon enable/disable flags
- worker timing such as `heartbeat_interval_seconds`
- maximum proactive processing time
- integration enablement and service reachability settings

Config changes can be pushed to the daemon manager through reload behavior in `services/daemons/daemon_control.py`.

## Frontend configuration

The frontend has two configuration layers:

- **bootstrap config** for startup and local environment discovery
- **runtime config** fetched from the backend settings API

Relevant sources:

- `aether-frontend/env.example`
- `aether-frontend/src/core/config/defaults.js`
- `aether-frontend/src/core/config/env-loader.js`
- `aether-frontend/src/core/config/port-resolver.js`
- `aether-frontend/src/domain/settings/`
