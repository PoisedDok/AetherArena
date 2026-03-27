# Security and Privacy

## Security goals

- keep Electron renderers unprivileged
- validate payloads at IPC, HTTP, and WebSocket boundaries
- isolate high-risk execution paths
- keep runtime secrets and service configuration out of hardcoded source paths
- preserve local-first privacy where the product is designed to do so

## Desktop boundary

The Electron side enforces the first security boundary:

- renderers do not receive raw Node.js privileges
- preload scripts expose validated `contextBridge` APIs
- IPC channels and payloads are whitelisted and validated before use
- renderer content is sanitized before display

## Backend boundary

The backend is responsible for:

- request validation through schemas and explicit constraints
- fail-fast rejection of malformed input
- authentication and rate-limiting policy from central network/security settings
- health and service-status reporting instead of silent degradation

Desktop-local defaults keep authentication and rate limiting disabled by default. Production-oriented configuration can enable both through backend settings.

## High-risk execution surfaces

### Open Interpreter

Open Interpreter is the highest-risk capability because it is meant to execute code.

The repo contains guardrails, not a claim of safety:

- it runs through `aether-backend/scripts/oi_server_wrapper.py`
- it is kept outside the backend process boundary
- communication is proxied instead of importing OI runtime code directly into the backend
- enablement is controlled through backend configuration

This contains blast radius. It does not make arbitrary code execution safe.

### Notebook and tool execution

Other execution-oriented features are also gated by backend settings and validation. The security model assumes these features are higher-risk and should remain explicit, auditable, and configurable.

## Container and daemon isolation

- Docker services run inside `aether-mesh-network`
- Perplexica is built locally from the checked-in service tree with `pull_policy: never`
- daemons use separate local stores and signal-based coordination instead of a network-exposed control plane
- daemon failures should not automatically collapse the entire backend runtime

## Privacy posture

- local inference and local storage paths exist to reduce unnecessary remote exposure
- external calls such as web search or remote providers are integrations, not hidden background behavior
- proactive data collection is runtime-configurable
- backend telemetry/analytics services are not part of the documented product architecture

## Limits

- code execution remains the largest security surface
- browser and email integrations still depend on host permissions
- enabling more capabilities increases attack surface even when the boundaries are better than a monolithic design

See `docs/licensing.md` for the AGPL/process-isolation side of the security story.
