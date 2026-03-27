# Quick Migration Guide

Use this directory for numbered SQL migrations and use the backend migration runner to apply them.

## Basic workflow

1. Create a new numbered SQL migration file in this directory.
2. Keep the migration idempotent where practical.
3. Test it against the local database setup.
4. Apply it through the backend migration tooling.

## Apply migrations

```bash
cd aether-backend
python3 scripts/run_migrations.py
```

## Naming

Use the existing `NNN_description.sql` pattern already present in this directory.

## Notes

- prefer the actual current migration files over stale examples from older docs
- verify any REST/API-side implications in the backend after changing schema
- use `README.md` in this directory for the current migration set
