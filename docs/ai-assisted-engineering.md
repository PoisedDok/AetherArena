# AI-Assisted Engineering

## What I am demonstrating

I built this project end-to-end with AI-assisted coding. That only works if AI output is treated as untrusted and forced to conform to a strict process. The project is also evidence that enforcing strict process on AI output does not sacrifice software engineering standards.

## The rules I enforce

- **Fail-fast boundaries**: invalid inputs and contract violations fail at boundaries (IPC, HTTP, WebSocket, persistence).
- **Central configuration**: no magic constants scattered in UI or business logic. I use the project's settings/config systems and keep defaults auditable.
- **Clean ownership**: frontend owns UI + IPC boundary enforcement; backend owns orchestration + persistence. No compensating for another layer's flaws.
- **Security-first desktop stance**: the renderer is not privileged; preloads expose only validated, minimal surfaces.
- **No drift tolerance**: documentation must match the repo. Tooling does not depend on missing files.

## Why this matters for agentic systems

Agentic systems are integration-heavy — they combine tools, data, and long-lived workflows. That makes them vulnerable to:

- Subtle contract drift (frontend/backend mismatch)
- Permission creep (tools become reachable without governance)
- Hidden glue code that becomes the real system (hard to test, hard to audit)

AI assistance helps me build faster, but I only allow speed when correctness is enforced by process and validation.

## What "done" means

For this project, "done" is not "it runs once." It is:

- End-to-end flows work hands-free (UI -> backend -> tools -> persistence -> UI)
- Central settings are respected (no hardcoding)
- Contract validation is green
- Architecture and tooling audits do not fail from missing sources or drift
- Security boundaries remain intact under adversarial inputs
