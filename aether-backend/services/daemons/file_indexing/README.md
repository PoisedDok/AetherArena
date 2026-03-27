# File Indexing Daemon

This directory contains the backend’s file-indexing daemon and related launcher assets.

## Purpose

- monitor configured filesystem locations
- maintain local indexing state
- support local retrieval workflows used by the backend

## Important note

Treat this daemon as part of the `services/daemons/` runtime, not as a separate standalone product with its own permanently stable operational contract.

## Related areas

- `aether-backend/services/daemons/file_indexing/`
- `aether-backend/services/daemons/file_indexing/launchers/`
- `docs/operations.md`
- `docs/configuration.md`

