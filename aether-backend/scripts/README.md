# Backend Scripts

Production-ready utilities for Aether Backend operations, maintenance, and analysis.

---

## 📜 Available Scripts

### 1. **job_tracer.py** - Job Type Pipeline Tracer 🆕
**Purpose**: Trace job types across the entire backend architecture using `@.architecture` documentation.

**Features**:
- Index and search 261 unique job types across 91 backend files
- Trace complete data flow pipelines (Incoming → Processing → Outgoing)
- Fuzzy search for related job types
- Export architecture as structured JSON
- Layer-by-layer visualization (API → Core → Data)

**Quick Start**:
```bash
# List all job types
./scripts/job_tracer.py list --sort frequency

# Search for files implementing a job type
./scripts/job_tracer.py search validation

# Trace complete pipeline
./scripts/job_tracer.py trace health_checking

# Fuzzy search
./scripts/job_tracer.py find stream

# Export to JSON
./scripts/job_tracer.py export architecture_index.json
```

**Common Use Cases**:
- 🔍 **Debugging**: Find all files involved in a feature
- 🏗️ **Development**: Understand system architecture
- 📊 **Analysis**: Identify patterns and dependencies
- 🧪 **Testing**: Verify integrations
- 🔐 **Security Audit**: Find security-critical code

**Documentation**: See [JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md) for comprehensive guide.

---

### 2. **health_check.py** - System Health Monitor
**Purpose**: Comprehensive health checking for all backend components.

**Features**:
- Database connectivity verification
- Service availability checks (Redis, Perplexica, Docling, LM Studio)
- System resource monitoring (CPU, memory, disk)
- Integration health validation
- Component dependency checking

**Usage**:
```bash
# Check all components
python3 scripts/health_check.py

# Check specific component
python3 scripts/health_check.py --component database

# JSON output for monitoring tools
python3 scripts/health_check.py --json
```

**Exit Codes**:
- `0` - All healthy
- `1` - Critical failure
- `2` - Degraded state

---

### 3. **validate_config.py** - Configuration Validator
**Purpose**: Validate all backend configuration files and settings.

**Features**:
- YAML/TOML schema validation
- Dependency verification
- Environment variable checking
- Network connectivity testing
- Integration registry validation

**Usage**:
```bash
# Validate all configs
python3 scripts/validate_config.py

# Validate specific config
python3 scripts/validate_config.py --file config/settings.py

# Check network connectivity
python3 scripts/validate_config.py --check-network
```

**Validates**:
- `config/settings.py` - Application settings
- `config/integrations_registry.yaml` - Integration definitions
- `config/models_config.toml` - LLM model configurations
- `.architecture/*.yaml` - Architecture standards

---

### 4. **run_migrations.py** - Database Migration Runner
**Purpose**: Manage database schema migrations with version tracking.

**Features**:
- Apply SQL migrations with versioning
- Rollback support
- Checksum validation
- Migration history tracking
- Dry-run mode

**Usage**:
```bash
# Run all pending migrations
python3 scripts/run_migrations.py

# Rollback last migration
python3 scripts/run_migrations.py --rollback

# Dry run (show what would be executed)
python3 scripts/run_migrations.py --dry-run

# Show migration status
python3 scripts/run_migrations.py --status
```

**Migration Files**: `database/migrations/*.sql`

---

### 5. **verify_oi_tool_integration.py** - OI Tool Integration Verifier
**Purpose**: Verify Open Interpreter tool catalog integration.

**Features**:
- Tool exposure verification
- Tool availability checking
- Execution testing
- Signature validation
- Integration health status

**Usage**:
```bash
# Verify all tools
python3 scripts/verify_oi_tool_integration.py

# Test specific tool
python3 scripts/verify_oi_tool_integration.py --tool mcp_list_servers

# Verbose output
python3 scripts/verify_oi_tool_integration.py --verbose
```

---

## 🔄 Workflow Integration

### Pre-Commit Hooks
```bash
# .git/hooks/pre-commit
#!/bin/bash
python3 scripts/validate_config.py || exit 1
python3 scripts/health_check.py --quick || exit 1
```

### CI/CD Pipeline
```yaml
# .github/workflows/backend-tests.yml
- name: Validate Configuration
  run: python3 scripts/validate_config.py

- name: Health Check
  run: python3 scripts/health_check.py

- name: Architecture Verification
  run: python3 scripts/job_tracer.py export arch.json
```

### Monitoring Integration
```bash
# Cron job for health monitoring
*/5 * * * * python3 /path/to/scripts/health_check.py --json > /var/log/aether/health.json
```

---

## 📊 Architecture Documentation

All scripts follow the `@.architecture` documentation standard:

```python
"""
@.architecture
Incoming: <source files> --- {<data types>}
Processing: <functions> --- {N jobs: <job types>}
Outgoing: <destination files> --- {<output types>}
"""
```

This enables the **job_tracer.py** tool to automatically index and trace all scripts!

---

## 🎯 Common Tasks

### New Developer Onboarding
```bash
# Understand the architecture
./scripts/job_tracer.py list --sort frequency

# See health check pipelines
./scripts/job_tracer.py trace health_checking

# Validate environment
python3 scripts/validate_config.py
python3 scripts/health_check.py
```

### Debugging Production Issues
```bash
# Find all files handling a specific job
./scripts/job_tracer.py search error_handling

# Trace data flow
./scripts/job_tracer.py trace message_routing

# Check system health
python3 scripts/health_check.py --verbose
```

### Security Audit
```bash
# Find all authentication/authorization
./scripts/job_tracer.py search authentication authorization

# Find input sanitization
./scripts/job_tracer.py search sanitization injection_detection

# Export for analysis
./scripts/job_tracer.py export security_audit.json
```

### Performance Analysis
```bash
# Find most common job types
./scripts/job_tracer.py list --sort frequency

# Trace streaming pipelines
./scripts/job_tracer.py trace streaming

# Export metrics
./scripts/job_tracer.py export metrics.json
```

---

## 🛠️ Development Guidelines

### Adding New Scripts

1. **Follow naming convention**: `<action>_<target>.py`
2. **Add `@.architecture` documentation** at the top
3. **Include docstrings** for all functions
4. **Make executable**: `chmod +x scripts/your_script.py`
5. **Update this README**
6. **Add tests** if applicable

### Script Template
```python
#!/usr/bin/env python3
"""
Script Title - Brief Description

Longer description of what the script does and why it exists.

@.architecture
Incoming: <sources> --- {<types>}
Processing: <functions> --- {N jobs: <job_types>}
Outgoing: <destinations> --- {<types>}
"""

import argparse
from pathlib import Path

def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description='Script description')
    # Add arguments
    args = parser.parse_args()
    # Implementation

if __name__ == '__main__':
    main()
```

---

## 📖 Related Documentation

- **[JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md)** - Comprehensive job tracer guide
- **[../.architecture/](../.architecture/)** - Architecture standards
  - `file_analysis_directive.yaml` - File documentation rules
  - `data_flow_standard.yaml` - Data flow patterns
  - `module_structure_standard.yaml` - Module organization
  - `security_compliance_standard.yaml` - Security requirements

---

## 🚀 Quick Reference

| Task | Command |
|------|---------|
| **Find files by job type** | `./scripts/job_tracer.py search <job_type>` |
| **Trace pipeline** | `./scripts/job_tracer.py trace <job_type>` |
| **Check system health** | `python3 scripts/health_check.py` |
| **Validate config** | `python3 scripts/validate_config.py` |
| **Run migrations** | `python3 scripts/run_migrations.py` |
| **Verify OI tools** | `python3 scripts/verify_oi_tool_integration.py` |
| **Export architecture** | `./scripts/job_tracer.py export arch.json` |

---

## 📈 Statistics

Current backend metrics:
- **91** production Python files documented
- **261** unique job types identified
- **13** architectural layers
- **5** production-ready scripts
- **100%** architecture documentation coverage

---

## 🔧 Troubleshooting

### Script won't run
```bash
# Make executable
chmod +x scripts/*.py

# Check Python version (requires 3.8+)
python3 --version
```

### Import errors
```bash
# Ensure correct working directory
cd /path/to/aether-backend

# Or set PYTHONPATH
export PYTHONPATH=/path/to/aether-backend:$PYTHONPATH
```

### Permission denied
```bash
# Run with appropriate permissions
sudo python3 scripts/script_name.py
```

---

## 🎓 Learning Resources

1. **Understanding the Architecture**: Start with `job_tracer.py list`
2. **Common Patterns**: See [JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md)
3. **Data Flow**: Trace with `job_tracer.py trace <job_type>`
4. **Standards**: Review `.architecture/*.yaml` files

---

**Maintained by the Aether Backend Team**  
Last Updated: November 2025
