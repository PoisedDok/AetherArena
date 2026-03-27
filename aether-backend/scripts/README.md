# Backend Scripts

This directory contains backend maintenance, validation, tracing, and setup utilities.

## Current script set

Verified scripts in this directory include:

- `job_tracer.py`
- `health_check.py`
- `validate_config.py`
- `run_migrations.py`
- `oi_server_wrapper.py`
- `searxng_server_wrapper.py`
- `generate_keys.py`
- `export_proactive_runs.py`
- `extract_action_source_catalog.py`
- `summary_eval_metrics.py`
- `validate_job_types.py`

## Common use

### Architecture tracing

```bash
cd aether-backend
python3 scripts/job_tracer.py list
python3 scripts/job_tracer.py search validation
python3 scripts/job_tracer.py trace streaming
```

### Configuration and health

```bash
cd aether-backend
python3 scripts/validate_config.py
python3 scripts/health_check.py
```

### Database migrations

```bash
cd aether-backend
python3 scripts/run_migrations.py
```

## Notes

- these scripts are part of the backend support surface, not the application API
- job-tracer usage is documented by the script itself and the architecture files; this README should not invent missing guide files
- wrapper scripts such as `oi_server_wrapper.py` exist because some integrations are intentionally kept outside the main backend process
