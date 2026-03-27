# Docling Integration Wrapper

This README covers the Aether-specific integration layer around Docling.

## What is Aether-owned here

- wrapper code that adapts the backend to Docling
- integration wiring used by the backend service layer
- local notes about how the embedded Docling tree is used in this repo

## What is not the source of truth

- upstream Docling documentation
- assumptions about a user-facing installer flow unless the current onboarding code still implements it

## Practical boundary

Treat this directory as a wrapper/integration area:

- `docling/` is the embedded upstream service tree
- Aether-specific wrapper code around it belongs to this repository
- licensing details should be checked against the local license files and `docs/licensing.md`
