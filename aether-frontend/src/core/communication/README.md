# Communication Layer

This directory contains the frontend’s transport primitives for HTTP and WebSocket traffic.

## Main components

- `Endpoint.js` — high-level façade used by the rest of the frontend
- `GuruConnection.js` — WebSocket client and stream transport
- `ApiClient.js` — HTTP client and request wrapper

## Responsibilities

- talk to the backend over HTTP and WebSocket
- handle connection lifecycle concerns such as reconnects, retries, and timeouts
- expose a single frontend-facing communication surface instead of scattering transport code across renderers
- cooperate with frontend security and validation layers before data crosses a boundary

## Related layers

- `../security/` for validation, sanitization, and client-side rate-limiting helpers
- `../../domain/` and `../../application/` for higher-level behavior built on top of these transport classes

## Development note

Treat these modules as transport infrastructure. Business rules should stay out of this layer.

