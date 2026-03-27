Incoming: Schema definitions (JSON Schema Draft 2020-12) --- {Object, json}
Processing: Define canonical contracts between frontend and backend layers --- {3 jobs: JOB_VALIDATE_SCHEMA, JOB_ENFORCE_INVARIANTS, JOB_TRACE}
Outgoing: Runtime validation, architecture documentation --- {Object, json}

# Aether Contracts

This directory contains the JSON Schema files that define shared payload shapes between the frontend and backend.

## Primary contract files

- `ws_message.schema.json`
- `ws_trail_events.schema.json`
- `artifact_stream.schema.json`
- `artifact_persistence.schema.json`
- `message_persistence.schema.json`
- `trail_hierarchy.schema.json`
- `chat_session_map.schema.json`
- `storage_artifact_update.schema.json`

## How to treat these files

- the schema files are the canonical contract source
- backend request/response validation should stay aligned with them
- frontend validators and IPC checks should stay aligned with them
- markdown should summarize purpose, not duplicate field-level definitions

## Change workflow

When a contract changes:

1. update the schema file here
2. update backend models or validators that mirror it
3. update frontend validators that mirror it
4. rerun the relevant validation and integration tests

## Related references

- `docs/architecture/API_DOCUMENTATION.md`
- `aether-backend/.architecture/backend_manifest.yaml`
- `aether-frontend/.architecture/frontend_manifest.yaml`
