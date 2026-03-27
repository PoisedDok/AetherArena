# Daemon Launchers

This directory contains launcher assets and service-wrapper material for backend daemons.

## Purpose

- make daemon-related startup/install assets easier to locate
- keep platform-specific launcher files separate from daemon logic

## What to treat as authoritative

- daemon runtime behavior lives under `aether-backend/services/daemons/`
- configuration sources live under backend settings and proactive config readers
- operational guidance belongs in `docs/operations.md` and `docs/configuration.md`

This README is only an orientation note. It should not be used as the source of truth for daemon feature lists or platform support claims.
