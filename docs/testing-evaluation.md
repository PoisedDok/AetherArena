# Testing and Evaluation

## Test layers

- **unit tests** for pure logic, validators, transformations, and boundary helpers
- **integration tests** for API handlers, persistence layers, and service adapters
- **end-to-end tests** for full flows such as chat, storage, daemon-driven behavior, and proactive execution

## What correctness means here

- contracts between frontend and backend stay aligned
- streamed events remain ordered and reconstructable
- invalid input fails early instead of being silently coerced
- background services do not create hidden state drift
- optional integrations fail visibly instead of corrupting the main workflow

## Evaluation focus

This project is evaluated as software engineering work, so the emphasis is on:

- requirements coverage
- operational reliability
- maintainability of the architecture
- realistic handling of failure modes
- security and privacy discipline

## Acceptance scenarios

The core scenarios worth validating end to end are:

- chat request -> streamed output -> persisted result
- tool-backed workflow -> validated output -> rendered artifact or result
- settings change -> backend persistence -> later runtime behavior reflects the change
- proactive activity -> query generation -> scout decision -> feedback capture
- file indexing -> searchable local retrieval
- local inference startup -> request handling -> idle cleanup behavior

## Evidence style

For each scenario, the useful evidence is:

- starting state
- user or system action
- expected visible result
- expected persisted result
- failure behavior when a dependency is unavailable

