# Platform Vision

## What AetherArena is for

AetherArena is intended to be a local-first desktop runtime for multiple AI-assisted workflows, not just a chat window. Agents can differ in goals, tools, and permissions while sharing the same governance, persistence, and runtime boundaries.

The current flagship profile is GURU, but the platform is meant to stay reusable beyond that one profile.

## Why local-first matters

Local-first is not branding. It changes the operating model:

- sensitive context can stay on the machine
- tool access and permissions can be enforced at the desktop boundary
- the product can remain useful even when external services are unavailable

That is why the codebase includes local inference routing, daemon-owned local storage, and desktop-level IPC/security boundaries.

## Core thesis

The hard part of an agentic desktop system is not producing words. It is deciding:

- what context to carry forward
- which tools are allowed to run
- how results are traced back to evidence
- when the system should stay silent

Those concerns shape the product more than any single model choice.

## Why the proactive system matters

The proactive pipeline is the clearest proof that the platform is more than chat. It combines:

- background activity capture
- explicit query generation
- a scout step that can decide to intervene or defer
- feedback storage for later reuse

The implementation details live in `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md`. The point here is architectural: AetherArena is built to support agent workflows that can act on accumulated context, not just immediate prompts.
