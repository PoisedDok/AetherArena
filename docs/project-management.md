# Project Management

## Scope

This is a software engineering project. The bar is a working system with defensible structure, not a demo that works once.

## Development approach

The repo reflects staged, iterative work:

- backend foundations and runtime boundaries
- frontend orchestration and UX wiring
- integration hardening across services, daemons, and settings
- documentation and consistency cleanup to keep the repo auditable

## AI-assisted development

AI assistance is part of the process, but only under explicit constraints:

- generated output is treated as untrusted until checked
- architecture boundaries take priority over convenience
- documentation drift is treated as a defect, not a cosmetic issue

## Professional conduct evidence

The university criteria are described in `docs/guide.txt`.

Repo-visible evidence includes:

- incremental git history
- project documentation explaining design, operations, and evaluation
- explicit architecture and configuration artifacts

Other evidence such as meeting records or time tracking may exist outside the repository and should not be claimed as repo files when they are not present here.

## Risks that shape the work

- **integration risk**: many moving parts can drift unless boundaries stay explicit
- **security risk**: desktop execution and tool access require hard limits and isolation
- **documentation risk**: stale paths and stale numbers quickly make the repo misleading
