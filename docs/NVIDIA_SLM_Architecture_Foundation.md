# NVIDIA SLM Architecture Foundation

**Reference:** Belcak et al. (2025). *Small Language Models are the Future of Agentic AI.*

This is a rationale document. It explains why AetherArena is built to support local, heterogeneous model routing. It does not define the exact model lineup for any given release.

## Why this paper matters here

The NVIDIA paper argues for an architecture pattern, not a single benchmark obsession:

- use smaller models when the task is narrow and repetitive
- keep the system heterogeneous instead of forcing one model to do everything
- favor local execution when privacy, latency, and cost matter

That maps well to a desktop product that mixes chat, search, orchestration, document work, and proactive assistance.

## What the repo actually supports

The current codebase already reflects that architectural direction in a few concrete ways:

- `aether-backend/services/aether_inference/server.py` exposes a single local inference surface on port `7090`
- `aether-backend/services/aether_inference/manager.py` supports multiple backends, including MLX, vLLM, and `llama.cpp`
- backend configuration separates model/provider defaults from runtime behavior through `config/models.toml` and `config/settings.py`
- the proactive pipeline is staged, which makes it possible to use different models or providers for different phases without rewriting the whole system

Those are implementation facts. They matter more than speculative benchmark tables in a project doc.

## Architectural consequences

### 1. Heterogeneous model routing is a feature, not a fallback

The backend is built so different workloads can use different inference backends or providers. That is the practical version of the SLM-first argument:

- keep routing flexible
- avoid hard-wiring one model family into every subsystem
- let deployment constraints shape model choice

### 2. Local execution supports the product boundary

AetherArena is a desktop application with privacy and latency constraints. Local inference is valuable here because it:

- reduces dependence on remote APIs
- keeps sensitive context on the machine when local models are used
- aligns with the broader local-first architecture described in the system docs

### 3. Task decomposition matters

The product already decomposes work into smaller stages and subsystems: chat, search, document handling, proactive retrieval, and daemon-driven activity capture. That decomposition is what makes smaller-model routing viable in the first place.

## What this document does not claim

This file is not proof that the repository currently ships:

- one fixed SLM stack for all proactive phases
- a single benchmark-validated model choice
- specific latency, VRAM, or token-per-second guarantees
- cost calculations for the exact deployment in this repo

If a release depends on a specific model lineup, document that in configuration or operations docs tied to the actual shipped settings.

## Relationship to the other docs

- Use `docs/architecture/system-architecture.md` for system topology
- Use `docs/configuration.md` for runtime configuration sources
- Use `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md` for proactive pipeline internals

## Practical takeaway

The NVIDIA paper supports the direction of this codebase: local-first, heterogeneous, and modular. The code proves the routing substrate exists. The exact model choices remain deployment and configuration concerns, not timeless architecture facts.

## Reference

Belcak, P., Heinrich, G., Diao, S., Fu, Y., Dong, X., Muralidharan, S., Lin, Y.C., & Molchanov, P. (2025). *Small Language Models are the Future of Agentic AI.* ArXiv:2506.02153.
