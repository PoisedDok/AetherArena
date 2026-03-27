# Artifacts Domain

This domain layer owns frontend-side artifact models, artifact lifecycle rules, execution-related helpers, and traceability support.

## Main areas

- models for artifact and execution-result state
- services for artifact creation, streaming, linking, and execution behavior
- repositories for persistence-facing access
- validators for domain-level checks

## Responsibilities

- turn streamed or generated output into artifact-domain objects
- keep artifacts linked to messages, chats, and traceability context
- coordinate artifact persistence through repository boundaries
- keep artifact rules out of renderer-only UI code

## Boundary rule

This directory is domain logic. It should not depend on renderer DOM state. UI modules should consume artifact-domain behavior, not reimplement it.

