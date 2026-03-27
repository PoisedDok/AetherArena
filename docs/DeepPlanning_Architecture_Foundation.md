# DeepPlanning Architecture Foundation

**Reference:** Zhang et al. (2026). *DeepPlanning: Benchmarking Long-Horizon Agentic Planning with Verifiable Constraints.*

This is a rationale document, not an implementation contract. It explains which DeepPlanning ideas shaped the proactive architecture and which implementation files carry those ideas in AetherArena.

## What the paper contributes

DeepPlanning is useful here because it isolates three failure classes that matter for proactive agents:

- **information acquisition failures**: the agent fails because it never gathered the right evidence
- **local reasoning failures**: the agent had some evidence but violated immediate constraints
- **global planning failures**: the agent produced a locally plausible action that was wrong in the larger workflow

That framing is more useful to this repo than any single benchmark number. It gives a way to reason about proactive failures without pretending that a long-horizon planning benchmark maps one-to-one onto this product.

## How that maps to AetherArena

### 1. Separate acquisition from decision-making

The proactive pipeline does not let the scout invent context from nothing.

- activity collection and query generation happen before scout execution
- the worker passes explicit `query_ids`, `queries`, and `source_docs` into `/v1/proactive/scout`
- the scout stores the resulting context and decision in `proactive_agent_runs`

Relevant implementation files:

- `aether-backend/services/daemons/query_generation/daemon.py`
- `aether-backend/services/daemons/query_generation/db.py`
- `aether-backend/workers/handlers/proactive_agent_handler.py`
- `aether-backend/api/v1/endpoints/proactive.py`

### 2. Treat constraints as runtime state, not just prompt text

The codebase already enforces some intervention constraints outside the model:

- recent chat activity can pause the proactive pipeline
- runtime config can disable proactive processing
- stale backlog is discarded instead of being treated as equally relevant
- user feedback is persisted and reused in later runs

That is the right lesson to take from DeepPlanning: if a constraint matters, encode it in system behavior where possible.

Relevant implementation files:

- `aether-backend/services/daemons/__init__.py`
- `aether-backend/services/daemons/query_generation/daemon.py`
- `aether-backend/workers/handlers/proactive_agent_handler.py`
- `aether-backend/application/agents/proactive_config_service.py`

### 3. Preserve outcomes for later learning

DeepPlanning argues that long-horizon agents need more than immediate success/failure labels. In AetherArena, the practical version of that idea is the feedback loop:

- scout output is stored in `proactive_agent_runs`
- feedback is captured as `clicked`, `dismissed`, or `timeout`
- later runs can reuse prior examples through the ICL manager or pgvector fallback

Relevant implementation files:

- `aether-backend/services/proactive/scout_service.py`
- `aether-backend/api/v1/endpoints/proactive.py`
- `aether-backend/data/database/migrations/004_agent_system.sql`

## What this document does not claim

This repo does **not** currently use this file as proof of:

- a specific scout model family
- a confidence-threshold fallback design
- mandatory source-coverage heuristics that are not visible in code
- a global optimizer that scores intervention plans in the abstract
- benchmark-derived latency or accuracy guarantees

If those become real implementation features, document them in `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md` only after the code exists.

## Practical takeaway

DeepPlanning matters here because it justifies the shape of the proactive pipeline:

- gather context before acting
- encode important constraints in runtime behavior
- preserve outcomes so the system can learn from prior runs

For implementation details, read `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md`.

## Reference

Zhang, Y., Jiang, S., Li, R., Tu, J., Su, Y., Deng, L., Guo, X., Lv, C., & Lin, J. (2026). *DeepPlanning: Benchmarking Long-Horizon Agentic Planning with Verifiable Constraints.* ArXiv:2601.18137.
