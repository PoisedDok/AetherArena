# WebSocket Unit Tests

This directory contains backend unit tests for the WebSocket layer.

## Focus areas

- hub and routing behavior
- event enrichment and message shaping
- cache/presence helpers
- control and lifecycle handling

## Run the tests

```bash
cd aether-backend
pytest tests/unit/ws/ -v
```

Use the individual test files in this directory when you need narrower coverage during debugging.
