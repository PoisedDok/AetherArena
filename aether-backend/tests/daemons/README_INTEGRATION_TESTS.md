# Daemon Integration Tests

This directory contains integration-oriented test helpers and scripts for daemon behavior, especially proactive and indexing flows.

## What these tests are for

- exercising daemon startup and shutdown behavior
- checking activity capture and query-generation flow
- validating that local daemon stores and signal-file coordination behave as expected

## How to use this directory

- run the specific test script you need from inside this directory
- treat expected counts and timings as environment-dependent unless the test itself asserts them
- prefer the code and script contents over stale README benchmarks

## Related implementation areas

- `aether-backend/services/daemons/`
- `aether-backend/workers/handlers/proactive_agent_handler.py`
- `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md`
