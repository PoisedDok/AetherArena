# Overview

AetherArena is a local-first desktop AI platform with an Electron frontend and a FastAPI backend. The repository combines chat, model routing, search, document tooling, persistent trails, and a proactive assistance pipeline.

For architecture detail, use:

- [System architecture](architecture/system-architecture.md)
- [Backend architecture](architecture/backend-architecture.md)
- [Frontend architecture](architecture/frontend-architecture.md)
- [Proactive system deep dive](PROACTIVE_SYSTEM_DEEP_DIVE.md)

## Intended use

The platform is aimed at workflows where privacy, provenance, and structured tool use matter more than a pure chat interface. The current flagship profile is GURU, but the codebase is structured to support multiple agents and workflows.

## Core goals

- local-first execution where practical
- clear ownership boundaries between frontend and backend
- central, auditable configuration
- traceable outputs backed by stored artifacts and trails
- proactive assistance built on explicit runtime controls rather than hidden automation

## Non-goals

- cloud-first hosting as a dependency
- masking system complexity behind undocumented glue code
- treating the app as a single-purpose chatbot instead of a governed desktop runtime
