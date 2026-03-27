# Proactive Agent - Phase 2 (Classifier -> Researcher -> Decision)

## Overview

Phase 2 now uses strict three-layer separation:

1. **Classifier** plans allowed tools and call budget.
2. **Researcher** executes only allowed tools and gathers evidence.
3. **Decision** returns only `intervene` or `defer` (+ recommendation or defer reason).

Legacy signal-gating and writer-layer coupling were removed from the runtime decision path.

## Runtime Flow

```
Phase 1 Query Generation (Python/SQLite)
  -> /v1/proactive/scout (Python orchestration)
  -> /api/proactive/scout (Perplexica TypeScript agent)
       classifier -> researcher -> decision
  -> Supabase persistence + optional WebSocket notification
```

## Core Files

- `types.ts` - contracts for `ProactiveInput`, `ResearchOutput`, `DecisionOutput`, `ProactiveOutput`
- `classifier.ts` - LLM structured planner for retriever/web calls and tool budget
- `scout/index.ts` - researcher loop (evidence gathering only)
- `decision.ts` - final decision LLM (`intervene`/`defer`)
- `scout/actions/registry.ts` - strict tool enablement from classifier plan
- `@/lib/prompts/proactive/classifier.ts` - classifier prompt
- `@/lib/prompts/proactive/scout.ts` - researcher prompt
- `@/lib/prompts/proactive/decision.ts` - decision prompt
- `index.ts` - orchestrator that wires all three layers

## Tooling Model

### Classifier output contract

- `retrieverCalls`: up to 2 calls
- `webSearchCalls`: up to 2 calls
- `maxToolCalls`: hard-capped to 4
- `reasoning`: classifier explanation string

Classifier does **not** decide intervene/defer.

### Researcher execution constraints

- Only tools enabled by classifier are exposed.
- Hard execution bounds:
  - max 2 calls per concrete tool
  - max 4 total executable calls
  - max 6 loop iterations
- Duplicate tool signatures are skipped.
- `__reasoning_preamble` stays available for traceability.
- Output is evidence only:
  - `findings`
  - `reasoningTrace`
  - `gatheredContext`

### Decision layer

- Input: queries + current activity + background + research output.
- Output:
  - `decision: "intervene" | "defer"`
  - `recommendation` (if intervene)
  - `deferReason` (if defer)
  - optional `supportingDocs`
- Prompt enforces observer-style, factual language and no generic filler.

## Removed Legacy Behavior

- No `mode` (`speed` / `balanced` / `deep`) in proactive agent contract.
- No `relevanceThreshold` in Phase 2 config payloads.
- No classifier `shouldDefer` or `urgency`.
- No signal-based gate (`coherentEngagement`, `novelContentFound`, `chatCorrelation`, `classifierHighUrgency`).
- No writer pass after scout; decision layer owns final output semantics.

## Output Contract (Perplexica -> Python API)

`ProactiveOutput` now returns:

- `decision`
- `context`
- `reasoning`
- optional `recommendation`
- optional `supportingDocs`
- optional `deferReason`
- optional `toolBudget`

No `relevanceScore`, `signals`, or `highSignalCount`.

## Example Usage

```typescript
import ProactiveAgent from '@/lib/agents/proactive';
import { ProactiveInput } from '@/lib/agents/proactive/types';

const agent = new ProactiveAgent();

const input: ProactiveInput = {
  queries: ['incident mitigation checklist'],
  currentActivity: [
    {
      source: 'email',
      timestamp: '2026-02-17T18:42:00Z',
      metadata: { subject: 'Prod incident update', sender: 'ops@company.com' },
    },
  ],
  backgroundHistory: [],
  iclExamples: [],
  config: {
    llm,
    embedding,
    apiBase: 'http://localhost:8765',
    maxProcessingTimeSeconds: 300,
  },
  session,
};

const output = await agent.scout(input);
// output.decision => "intervene" | "defer"
```

## Notes

- Phase 4 ICL examples are injected by Python before agent execution.
- Notification streaming is handled outside Perplexica by the worker via WebSocket.
- The database representation of budget is normalized in Python as `agent_mode=budget_N`.
