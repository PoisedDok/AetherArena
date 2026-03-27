# Licensing

## Top-level license

The repository is licensed under `BUSL-1.1-2025`.

Verified from `LICENSE`:

- **Licensor**: Krish Dokania
- **Change Date**: `2029-11-21`
- **Change License**: Apache License 2.0
- **Additional Use Grant**: non-commercial, personal, testing, and development use

This is not an Apache-2.0 repository today.

## Integration exception

The top-level license explicitly includes an AGPL/open-source integration exception for interfacing with separately licensed software through network APIs, IPC, or process spawning.

That matters because the architecture relies on process or container isolation for some third-party dependencies.

## Third-party code in the repo

The service tree contains embedded or vendored third-party components with their own licenses, including:

- `aether-backend/services/perplexica/` — MIT
- `aether-backend/services/aether-rag/` — MIT
- `aether-backend/services/docling/` — MIT
- `aether-backend/services/xlwings/` — BSD-style license (`LICENSE.txt`)
- `aether-backend/services/realtime-tts/` — MIT

Use `THIRD-PARTY-NOTICES` for the broader attribution set.

## AGPL dependencies

Two AGPL-licensed runtime dependencies matter to the architecture:

### Open Interpreter

- used through an external server path
- launched via `aether-backend/scripts/oi_server_wrapper.py`
- kept outside the backend process boundary

### SearXNG

- used through the Docker mesh
- runs as a separate service/container
- not maintained here as a first-party source subtree

## What this document can safely claim

- the repo’s top-level license is BUSL, not Apache or MIT
- the repo includes permissive third-party service trees with their own license files
- AGPL dependencies exist in the runtime story, but the architecture isolates them at process or container boundaries

## What this document should not claim

- that the repo has no copyleft dependencies
- that all third-party code is bundled the same way
- that nonexistent local vendor directories are part of the maintained repository structure
