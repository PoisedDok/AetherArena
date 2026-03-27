# Aether Backend Services

This directory contains the backend-owned service integrations and runtime subsystems that the Python API orchestrates.

## Main service groups

- `aether_inference/` — local model routing and serving
- `daemons/` — background activity and indexing services
- `proactive/` — proactive scout orchestration support
- `agents/` — agent-related service logic
- `perplexica/` — embedded service tree for AI-assisted search
- `aether-rag/` — local retrieval/indexing service tree
- `docling/` — document-processing integration area
- `xlwings/` — spreadsheet automation integration area
- `realtime-tts/` — text-to-speech integration area
- `external-services/` — Docker mesh definition

## Runtime model

- **Docker mesh services** live under `external-services/`
- **daemon-managed services** live under `daemons/`
- **managed local inference** lives under `aether_inference/`
- **on-demand library integrations** are wrapped by backend code instead of being treated as first-class backend layers

## Important boundaries

- treat `services/` as the integration layer, not the API layer
- do not assume every subtree is first-party source; several are embedded service trees with their own licenses and upstream histories
- AGPL-sensitive runtime dependencies are handled through process or container boundaries, not by pretending they do not exist

## Where to look next

- `../config/` for configuration sources
- `../core/integrations/` for integration wrappers and adapters
- `../services/daemons/` for background collectors and proactive inputs
- `../services/external-services/docker-compose.yml` for the Docker mesh

## Licensing

Each embedded service keeps its own license file. Use `docs/licensing.md` and `THIRD-PARTY-NOTICES` for the repo-level view.
