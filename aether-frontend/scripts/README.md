# Frontend Scripts

This directory contains frontend build, tracing, audit, and notice-generation utilities.

## Current script set

Verified scripts in this directory include:

- `job_tracer.js`
- `afterPack.js`
- `generate-notices.js`
- `security-audit.js`
- `validate_job_types.js`

## Common use

### Architecture tracing

```bash
cd aether-frontend
node scripts/job_tracer.js list
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN
node scripts/job_tracer.js trace JOB_EMIT_EVENT
```

### Packaging and notices

```bash
cd aether-frontend
node scripts/generate-notices.js
node scripts/afterPack.js
```

### Validation and audit

```bash
cd aether-frontend
node scripts/validate_job_types.js
node scripts/security-audit.js
```

## Notes

- this README should describe the scripts that actually exist, not point to missing guide files
- the frontend job tracer complements the backend tracer, but each script documents its own usage
- the scripts directory is a support surface for build and architecture work, not part of the runtime renderer API

