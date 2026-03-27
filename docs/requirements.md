# Requirements

## Functional

- **Desktop AI assistant UI**: run the Electron app and interact via chat with streaming responses.
- **On-device model inference**: route requests to locally-hosted models (MLX, vLLM, llama.cpp) with lazy loading and idle eviction, without requiring cloud API keys.
- **Tool execution**: invoke tools (local and service-backed) and present results in a usable form.
- **Artifacts and trails**: persist and reconstruct artifacts and execution trails so interactions are reproducible and debuggable.
- **Document handling**: ingest documents (via Docling OCR + structure extraction) and use them as evidence for downstream workflows.
- **Search**: web search (SearXNG + Perplexica) and local semantic search (Aether-RAG with FAISS-HNSW, BM25 via PyTerrier).
- **File indexing**: monitor local directories via daemon and provide semantic search over indexed files.
- **Proactive agent**: autonomously monitor user activity (browser, email, filesystem), generate search queries from patterns, and surface relevant insights via notifications.
- **Agent workflows**: support multiple agents with distinct goals and tool access (research, memory).
- **Settings**: view and update settings via a central settings system (backend canonical, frontend consumes via `/v1/settings/`).

## Non-functional

- **Security**: renderers sandboxed; IPC boundaries validated; unsafe content sanitised; risky capabilities gated by settings; daemons process-isolated; Docker services in isolated network.
- **Privacy**: local-first where possible (on-device inference, local indexing, local activity monitoring); external calls are explicit integrations; per-source activity monitoring toggles.
- **Reliability**: fail-fast on invalid contracts; graceful degradation when optional integrations are disabled; Docker container health checks; daemon process isolation prevents cascade failures.
- **Maintainability**: clean architecture boundaries; no cross-layer workarounds; centralised configuration; typed settings models.
- **Auditability**: contracts and persisted trails support traceability; proactive agent runs stored with full execution traces, reasoning, and user feedback.

## Out of scope

- Cloud-first hosting and external proxy infrastructure as a dependency.
- Claiming novelty via "no competitor exists" — I define the gap I target instead.
