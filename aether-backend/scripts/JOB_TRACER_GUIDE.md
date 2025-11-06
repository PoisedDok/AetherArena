# Job Tracer Guide

**Job Type Pipeline Tracer** - Production-ready tool for tracing job types across the Aether backend architecture.

## Overview

The Job Tracer analyzes all `@.architecture` documentation in the backend codebase to:
- **Index files by job type** (261 unique job types across 91 files)
- **Search for files** implementing specific job types
- **Trace complete pipelines** from API layer to data layer
- **Visualize data flow** through the system
- **Export architecture** as structured JSON

---

## Quick Start

```bash
# Navigate to backend
cd /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend

# Make executable (if not already)
chmod +x scripts/job_tracer.py

# List all job types
./scripts/job_tracer.py list

# Search for a specific job type
./scripts/job_tracer.py search validation

# Trace a complete pipeline
./scripts/job_tracer.py trace streaming
```

---

## Commands

### 1. **List** - Show all job types

```bash
# Alphabetical order (default)
./scripts/job_tracer.py list

# By frequency (most common first)
./scripts/job_tracer.py list --sort frequency
```

**Output:**
```
📋 ALL JOB TYPES
📊 Total unique job types: 261

   • health_checking                          (12 file(s))
   • data_validation                          (9 file(s))
   • serialization                            (9 file(s))
   ...
```

---

### 2. **Search** - Find files by job type(s)

#### Single job type
```bash
./scripts/job_tracer.py search validation
```

#### Multiple job types (OR logic - matches ANY)
```bash
./scripts/job_tracer.py search validation sanitization
```

#### Multiple job types (AND logic - matches ALL)
```bash
./scripts/job_tracer.py search validation sanitization --all
```

**Output:**
```
🔍 SEARCH RESULTS: validation
📊 Found 5 file(s) matching job type(s): validation

1. 📄 security/sanitization.py
   ──────────────────────────────────────────────────────────────────────
   Jobs: injection_detection, path_validation, sanitization, size_validation, validation (5 total)
   
   ⬇️  Incoming:  api/v1/endpoints/*.py, User input --- {str text, bytes file content, str path, str URL, Dict JSON payload}
   ⚙️  Processing: sanitize_text(), sanitize_filename(), sanitize_path(), validate_file_upload(), check_sql_injection() --- {5 jobs: injection_detection, path_validation, sanitization, size_validation, validation}
   ⬆️  Outgoing:   api/v1/endpoints/*.py --- {str sanitized text, Path validated path, Dict[str, Any] file info, raises ValidationError}
```

---

### 3. **Trace** - Complete pipeline visualization

```bash
./scripts/job_tracer.py trace health_checking
```

**Output:**
```
🔬 PIPELINE TRACE: health_checking
📊 Found 12 file(s) implementing 'health_checking'

📂 Distribution by Layer:
   • API Endpoints: 2 file(s)
   • Integrations: 4 file(s)
   • Monitoring: 1 file(s)
   • Data Layer: 1 file(s)
   ...

🗺️  Complete Pipeline:

   1. API Endpoints
   ──────────────────────────────────────────────────────────────────────
   └─ 📄 api/v1/endpoints/mcp.py
      ⬇️  api/v1/router.py, Frontend (HTTP POST/GET/DELETE) --- {...}
      ⚙️  register_server(), start_server(), check_server_health() --- {9 jobs: ...}
      ⬆️  core/mcp/manager.py, Frontend (HTTP) --- {...}
   
   7. Integrations
   ──────────────────────────────────────────────────────────────────────
   └─ 📄 core/integrations/framework/health.py
      ⬇️  config/integrations_registry.yaml, core/integrations/libraries/* --- {...}
      ⚙️  check_all(), _check_load(), _check_attach() --- {5 jobs: ...}
      ⬆️  Testing/monitoring tools, Scripts --- {...}
```

Shows files grouped by layer (API → Core → Data) with complete data flow!

---

### 4. **Find** - Fuzzy search for job types

```bash
./scripts/job_tracer.py find stream
```

**Output:**
```
🔍 Fuzzy search for: 'stream'
📊 Found 5 matching job types:

   • streaming (1 file(s))
   • streaming_coordination (1 file(s))
   • streaming_orchestration (1 file(s))
   • streaming_synthesis (1 file(s))
   • stream_generation (1 file(s))
```

Perfect for discovering related job types!

---

### 5. **Export** - Generate JSON index

```bash
./scripts/job_tracer.py export architecture_index.json
```

**JSON Structure:**
```json
{
  "total_files": 91,
  "total_job_types": 261,
  "job_types": ["abstraction", "aggregation", ...],
  "job_index": {
    "validation": [
      {
        "file": "security/sanitization.py",
        "jobs": ["injection_detection", "path_validation", "sanitization", "size_validation", "validation"],
        "job_count": 5,
        "incoming": "api/v1/endpoints/*.py, User input --- {...}",
        "processing": "sanitize_text(), sanitize_filename() --- {...}",
        "outgoing": "api/v1/endpoints/*.py --- {...}"
      }
    ]
  }
}
```

Use this for:
- CI/CD integration
- Architecture documentation
- Automated testing
- Code analysis tools

---

## Common Use Cases

### 🔍 **Debugging**: Find all files involved in a feature
```bash
# Find everything related to WebSocket streaming
./scripts/job_tracer.py trace streaming_coordination

# Find security-related operations
./scripts/job_tracer.py search sanitization validation encryption
```

### 🏗️ **Development**: Understand system architecture
```bash
# See all health check mechanisms
./scripts/job_tracer.py trace health_checking

# Find all data validation layers
./scripts/job_tracer.py search data_validation
```

### 📊 **Analysis**: Identify patterns
```bash
# Which job types are most common?
./scripts/job_tracer.py list --sort frequency

# Export for analysis
./scripts/job_tracer.py export ~/analysis/backend_arch.json
```

### 🧪 **Testing**: Verify integrations
```bash
# Find all integration test points
./scripts/job_tracer.py search integration_testing

# Trace tool execution pipeline
./scripts/job_tracer.py trace tool_execution
```

### 🔐 **Security Audit**: Find security-critical code
```bash
# All authentication/authorization
./scripts/job_tracer.py search authentication authorization

# All input sanitization
./scripts/job_tracer.py search sanitization injection_detection
```

---

## Most Common Job Types

Based on our backend architecture:

| Job Type | Files | Use Case |
|----------|-------|----------|
| `health_checking` | 12 | System monitoring, service health |
| `data_validation` | 9 | Input validation, schema checking |
| `serialization` | 9 | API schemas, data conversion |
| `lifecycle_management` | 5 | Component startup/shutdown |
| `tool_discovery` | 5 | Open Interpreter integration |
| `validation` | 5 | General validation operations |
| `tool_execution` | 4 | MCP and integration tools |
| `path_validation` | 4 | File system security |

---

## Architecture Layers

The tracer organizes files into these layers:

1. **API Endpoints** - HTTP endpoints (`api/v1/endpoints/`)
2. **API Schemas** - Pydantic models (`api/v1/schemas/`)
3. **Middleware** - Request/response processing (`api/middleware/`)
4. **WebSocket** - Real-time communication (`ws/`)
5. **Core Runtime** - Open Interpreter engine (`core/runtime/`)
6. **MCP** - Model Context Protocol (`core/mcp/`)
7. **Integrations** - External services (`core/integrations/`)
8. **Data Layer** - Database, cache, storage (`data/`)
9. **Security** - Auth, crypto, validation (`security/`)
10. **Monitoring** - Health, logging, metrics (`monitoring/`)
11. **Utils** - Shared utilities (`utils/`)
12. **Config** - Settings management (`config/`)
13. **Scripts** - CLI tools (`scripts/`)

---

## JSON Output Mode

Add `--json` flag to any search command:

```bash
./scripts/job_tracer.py search validation --json
```

Output:
```json
{
  "query": ["validation"],
  "match_mode": "any",
  "total_results": 5,
  "results": [
    {
      "file": "security/sanitization.py",
      "jobs": ["injection_detection", "path_validation", "sanitization", "size_validation", "validation"],
      "incoming": "...",
      "processing": "...",
      "outgoing": "..."
    }
  ]
}
```

---

## Tips & Best Practices

### 🎯 **Start Broad, Then Narrow**
```bash
# 1. Find related job types
./scripts/job_tracer.py find stream

# 2. Trace specific one
./scripts/job_tracer.py trace streaming_coordination
```

### 🔗 **Follow the Pipeline**
Look at the data flow in trace output:
- **Incoming** → What data/files call this?
- **Processing** → What functions/jobs run?
- **Outgoing** → Where does data go next?

### 🔍 **Use AND/OR Logic Strategically**
```bash
# OR: Files with EITHER job (broader)
./scripts/job_tracer.py search validation sanitization

# AND: Files with BOTH jobs (narrower)
./scripts/job_tracer.py search validation sanitization --all
```

### 📊 **Export for Documentation**
```bash
# Generate architecture documentation
./scripts/job_tracer.py export docs/architecture_index.json

# Then process with jq or Python for reports
cat docs/architecture_index.json | jq '.job_types | length'
```

---

## Integration Examples

### CI/CD Pipeline
```yaml
# .github/workflows/architecture-check.yml
- name: Verify Architecture Documentation
  run: |
    python3 scripts/job_tracer.py export arch.json
    python3 scripts/validate_arch.py arch.json
```

### Pre-commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit
python3 scripts/job_tracer.py export /tmp/arch_check.json
if [ $? -ne 0 ]; then
  echo "❌ Architecture scan failed"
  exit 1
fi
```

### Documentation Generation
```python
import json

# Load architecture
with open('architecture_index.json') as f:
    arch = json.load(f)

# Generate markdown
for job_type in sorted(arch['job_types']):
    files = arch['job_index'][job_type]
    print(f"## {job_type}\n")
    for file_info in files:
        print(f"- `{file_info['file']}`")
```

---

## Performance

- **Scan time**: ~0.5s for 91 files
- **Memory usage**: <50MB
- **JSON export**: ~500KB
- **Regex-based parsing**: Fast and reliable

---

## Troubleshooting

### No files found?
```bash
# Verify @.architecture documentation exists
grep -r "@.architecture" . --include="*.py" | wc -l
# Should show 91
```

### Wrong backend directory?
```bash
# Script auto-detects from scripts/ location
# Or set manually:
cd /path/to/aether-backend
python3 scripts/job_tracer.py list
```

### Job type not found?
```bash
# Use fuzzy search to find similar
./scripts/job_tracer.py find <partial_name>
```

---

## Future Enhancements

Potential additions:
- **Call graph visualization** (Graphviz integration)
- **Dependency analysis** (which files depend on which)
- **Change impact analysis** (what breaks if file changes)
- **Performance hotspot detection** (most-called jobs)
- **Interactive web UI** (browse architecture visually)

---

## Related Tools

- `scripts/health_check.py` - System health monitoring
- `scripts/validate_config.py` - Configuration validation
- `scripts/verify_oi_tool_integration.py` - OI tool integration testing

---

## Support

For issues or questions:
1. Check `@.architecture` documentation in source files
2. Review `.architecture/*.yaml` standards
3. Run with `--help` for command reference

---

**Built with ❤️ for the Aether Backend**

