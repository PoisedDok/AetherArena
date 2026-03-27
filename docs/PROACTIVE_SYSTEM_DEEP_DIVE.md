# Proactive System Deep Dive

This document covers the proactive pipeline only. For general system topology, ports, and cross-platform ownership, use `docs/architecture/system-architecture.md`.

## What this pipeline does

The proactive system turns background activity into candidate interventions in three stages:

1. **Collect activity** from daemon-owned sources
2. **Generate proactive queries** from fresh activity batches
3. **Scout and learn** from previous proactive outcomes before deciding whether to intervene

## Phase 1: Activity capture and query generation

### Source daemons

The proactive input layer is built around daemon-owned SQLite stores for:

- browser activity
- email activity
- filesystem activity

These daemons feed the query-generation stage through a shared signal file:

- `services/daemons/__init__.py` defines `QUERY_GEN_SIGNAL_FILE` as `/tmp/query_gen_signal.trigger`
- `CHAT_ACTIVITY_SIGNAL_FILE` at `/tmp/chat_activity.trigger` pauses proactive processing while the user is actively chatting

### Query-generation daemon

`aether-backend/services/daemons/query_generation/daemon.py` is event-driven, not a blind polling loop for new logs.

Key behavior that is actually implemented:

- a watchdog observer listens for changes to `/tmp/query_gen_signal.trigger`
- signals arriving during active processing are queued through `_pending_signal` instead of being dropped
- the daemon can pause during recent chat activity and discard stale backlog after the pause ends
- startup marks previously unprocessed activity as stale so a fresh daemon instance only works on current activity
- maintenance checks run in the background for config reload, cleanup, and missed-signal recovery

### Query storage

Generated queries are stored in `data/daemons/query_generation/queries.db` in the `generated_queries` table.

Verified fields and behaviors from `services/daemons/query_generation/db.py`:

- `query_id` identifies generated queries for downstream linkage
- `batch_id` groups related query-generation output
- `used_by_agent` tracks whether the proactive worker has consumed a query
- `indexed` tracks BM25 indexing state
- `get_last_batch_queries()` pulls from the last three batches to preserve recent context

## Phase 2: Worker and scout execution

### Proactive worker

`aether-backend/workers/handlers/proactive_agent_handler.py` runs a heartbeat loop over `queries.db`.

Verified worker rules:

- default heartbeat interval is 10 seconds through `config/schemas/proactive.py`
- only one worker cycle can process at a time because `self.processing` gates concurrency
- the worker reads runtime config and can disable itself dynamically
- if the user is actively chatting, the worker skips new proactive work
- the worker selects the most recent unprocessed query and marks older unprocessed queries from other batches stale instead of building backlog
- failures use bounded retries and exponential backoff instead of tight retry loops

### Scout API boundary

The worker calls `POST /v1/proactive/scout`, implemented in `aether-backend/api/v1/endpoints/proactive.py`.

That endpoint:

- accepts query IDs, generated queries, source documents, and day/date metadata
- delegates execution to `services/proactive/scout_service.py`
- stores the result in `proactive_agent_runs`
- returns either `intervene` or `defer`, plus recommendation/context metadata when present

### Result storage

`aether-backend/data/database/migrations/004_agent_system.sql` defines `proactive_agent_runs` with fields including:

- `decision`
- `recommendation`
- `supporting_docs`
- `context_gathered`
- `executed_tools`
- `tool_calls_count`
- `execution_time_ms`
- `user_feedback`
- `context_embedding vector(384)`

## Phase 3: ICL and feedback loop

`services/proactive/scout_service.py` builds a `rich_context_text` from the current source documents and generated queries before scout execution.

The current implementation tries retrieval in this order:

1. Generate a context embedding through the configured embedding service
2. Use the Aether-RAG-backed proactive ICL manager when its index is ready
3. Fall back to pgvector similarity search over `proactive_agent_runs` when no local ICL examples are available

### Feedback signals

`POST /v1/proactive/{run_id}/feedback` records one of:

- `clicked`
- `dismissed`
- `timeout`

Feedback is not just analytics. It is fed back into the ICL path so future proactive runs can reuse successful or cautionary patterns.

## Runtime controls

The proactive pipeline is controlled by central settings plus runtime config reads:

- daemon enable flags such as `browser_enabled`, `email_enabled`, `file_system_enabled`, `query_generation_enabled`
- worker timing such as `heartbeat_interval_seconds` and `max_processing_time_seconds`
- daemon-manager reloads triggered through `services/daemons/daemon_control.py`, which uses `SIGHUP` for config reload

## Source-of-truth files

If this pipeline changes, update these files before updating any narrative docs:

- `aether-backend/services/daemons/__init__.py`
- `aether-backend/services/daemons/query_generation/daemon.py`
- `aether-backend/services/daemons/query_generation/db.py`
- `aether-backend/workers/handlers/proactive_agent_handler.py`
- `aether-backend/api/v1/endpoints/proactive.py`
- `aether-backend/services/proactive/scout_service.py`
- `aether-backend/data/database/migrations/004_agent_system.sql`

## Boundaries

- Keep general system topology in `docs/architecture/system-architecture.md`
- Keep proactive internals here
- Do not restate speculative agent heuristics unless they are still visible in code
