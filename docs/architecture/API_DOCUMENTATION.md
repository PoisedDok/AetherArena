# API Documentation

The live API surface is generated from the backend. Use this file as a guide to the documentation endpoints and the contract sources, not as a duplicate endpoint catalog.

## Live references

- **Swagger UI**: `http://localhost:8765/docs`
- **ReDoc**: `http://localhost:8765/redoc`
- **OpenAPI JSON**: `http://localhost:8765/v1/docs/openapi`

At the current repo state, the backend exposes **37 route modules** and **237 HTTP routes** under `api/v1/endpoints/`.

## Documentation helper endpoints

`api/v1/endpoints/api_docs.py` defines six helper endpoints under `/v1/docs`:

- `GET /v1/docs` — grouped API catalog
- `GET /v1/docs/stats` — aggregate counts by method and tag
- `GET /v1/docs/tags` — tag list and per-tag counts
- `GET /v1/docs/endpoint` — detail for a single method/path pair
- `GET /v1/docs/schemas` — reusable schema list
- `GET /v1/docs/openapi` — raw OpenAPI document

## Useful commands

```bash
# Health
curl http://localhost:8765/health
curl http://localhost:8765/v1/health

# Full API catalog
curl http://localhost:8765/v1/docs

# Route stats
curl http://localhost:8765/v1/docs/stats

# Single endpoint detail
curl 'http://localhost:8765/v1/docs/endpoint?path=/v1/health&method=GET'

# Export OpenAPI
curl http://localhost:8765/v1/docs/openapi > aether-openapi.json
```

## Contracts

`contracts/*.schema.json` remains the canonical source for shared payload shapes. Markdown should point to those schema files, not restate field definitions by hand.

The key cross-layer contracts include:

- `contracts/artifact_persistence.schema.json`
- `contracts/artifact_stream.schema.json`
- `contracts/chat_session_map.schema.json`
- `contracts/message_persistence.schema.json`
- `contracts/storage_artifact_update.schema.json`
- `contracts/trail_hierarchy.schema.json`
- `contracts/ws_message.schema.json`
- `contracts/ws_trail_events.schema.json`

## Authentication and rate limiting

Defaults live in `aether-backend/config/schemas/network.py`.

- Desktop-local defaults keep `auth_enabled` and `rate_limit_enabled` disabled
- Production profiles can enable both through configuration and environment overrides

For the live tag list, route count, or schema inventory, query `/v1/docs*` directly instead of relying on markdown snapshots.
