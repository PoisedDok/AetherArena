# Database Migrations

This directory contains the SQL migrations used by the backend database layer.

## Current migration set

The maintained numbered migrations in this directory are:

1. `000_core_schema.sql`
2. `001_audit_system.sql`
3. `002_mcp_and_memory.sql`
4. `003_job_system.sql`
5. `004_agent_system.sql`
6. `005_preferences_system.sql`
7. `006_file_indexing.sql`

## Operational note

Use the backend migration tooling from `aether-backend/scripts/run_migrations.py` rather than relying on old README assumptions about historical migration chains.
