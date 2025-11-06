# Job Tracer Guide - Frontend Edition

**Job Type Pipeline Tracer** - Production-ready tool for tracing JOB_* types across the Aether frontend architecture.

## Overview

The Job Tracer analyzes all `@.architecture` documentation in the frontend codebase to:
- **Index files by JOB_* type** (292 unique job types across 142 files)
- **Search for files** implementing specific job types
- **Trace complete pipelines** from UI to infrastructure
- **Visualize data flow** through the system
- **Export architecture** as structured JSON

---

## Quick Start

```bash
# Navigate to frontend
cd /Volumes/Disk-D/Aether/Aether/AetherArena/aether-frontend

# Make executable (if not already)
chmod +x scripts/job_tracer.js

# List all job types
node scripts/job_tracer.js list

# Search for a specific job type
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN

# Trace a complete pipeline
node scripts/job_tracer.js trace JOB_EMIT_EVENT
```

---

## Commands

### 1. **List** - Show all job types

```bash
# Alphabetical order (default)
node scripts/job_tracer.js list

# By frequency (most common first)
node scripts/job_tracer.js list --sort frequency
```

**Output:**
```
📋 ALL JOB TYPES
📊 Total unique job types: 292

   • JOB_EMIT_EVENT                                     (42 file(s))
   • JOB_UPDATE_STATE                                   (33 file(s))
   • JOB_GET_STATE                                      (30 file(s))
   • JOB_VALIDATE_SCHEMA                                (23 file(s))
   ...
```

---

### 2. **Search** - Find files by job type(s)

#### Single job type
```bash
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN
```

#### Multiple job types (OR logic - matches ANY)
```bash
node scripts/job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA
```

#### Multiple job types (AND logic - matches ALL)
```bash
node scripts/job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA --all
```

**Output:**
```
🔍 SEARCH RESULTS: JOB_RENDER_MARKDOWN
📊 Found 4 file(s) matching job type(s): JOB_RENDER_MARKDOWN

1. 📄 src/renderer/artifacts/modules/code/CodeViewer.js
   ──────────────────────────────────────────────────────────────────────
   Jobs: JOB_CREATE_DOM_ELEMENT, JOB_RENDER_MARKDOWN, JOB_UPDATE_DOM_ELEMENT, ... (8 total)
   
   ⬇️  Incoming:  ArtifactsController (loadCode method), IPC 'artifacts:load-code' events
   ⚙️  Processing: Create tab-based UI, lazy load ACE editor & Highlight.js, render syntax highlighted code
   ⬆️  Outgoing:   DOM (code editor with syntax highlighting), ArtifactsController.executeCode()
```

---

### 3. **Trace** - Complete pipeline visualization

```bash
node scripts/job_tracer.js trace JOB_EMIT_EVENT
```

**Output:**
```
🔬 PIPELINE TRACE: JOB_EMIT_EVENT
📊 Found 42 file(s) implementing 'JOB_EMIT_EVENT'

📂 Distribution by Layer:
   • Chat: 11 file(s)
   • Main Process: 10 file(s)
   • Artifacts: 7 file(s)
   • Other: 8 file(s)
   ...

🗺️  Complete Pipeline:

   Main Process
   ──────────────────────────────────────────────────────────────────────
   └─ 📄 src/application/main/MainOrchestrator.js
      ⬇️  GuruConnection.on('message') (WebSocket events), IpcBridge.on('main:*') (IPC commands)
      ⚙️  Initialize RequestLifecycleManager, coordinate submodules, route messages/requests
      ⬆️  GuruConnection.send() → Backend WebSocket, IpcBridge.send() → Chat/Artifacts windows
   
   Chat
   ──────────────────────────────────────────────────────────────────────
   └─ 📄 src/renderer/chat/modules/messaging/MessageManager.js
      ⬇️  StreamHandler (user messages), IPC 'chat:stream' (assistant chunks)
      ⚙️  Track entities (messages/chats/artifacts), generate session IDs, manage state
      ⬆️  MessageView.render(), EventBus.emit(), IPC send to main
```

Shows files grouped by layer with complete data flow!

---

### 4. **Find** - Fuzzy search for job types

```bash
node scripts/job_tracer.js find render
```

**Output:**
```
🔍 Fuzzy search for: 'render'
📊 Found 5 matching job types:

   • JOB_RENDER_MARKDOWN (4 file(s))
   • JOB_RENDER_HTML (2 file(s))
   • JOB_RENDER_3D (1 file(s))
   • JOB_RENDER_CODE (1 file(s))
   • JOB_RERENDER_VIEW (1 file(s))
```

Perfect for discovering related job types!

---

### 5. **Export** - Generate JSON index

```bash
node scripts/job_tracer.js export architecture_index.json
```

**JSON Structure:**
```json
{
  "totalFiles": 142,
  "totalJobTypes": 292,
  "jobTypes": ["JOB_ABORT_TIMEOUT", "JOB_ACCUMULATE_TEXT", ...],
  "jobIndex": {
    "JOB_RENDER_MARKDOWN": [
      {
        "file": "src/renderer/artifacts/modules/code/CodeViewer.js",
        "jobs": ["JOB_CREATE_DOM_ELEMENT", "JOB_RENDER_MARKDOWN", ...],
        "jobCount": 8,
        "incoming": "ArtifactsController (loadCode method), IPC events --- {...}",
        "processing": "Create tab-based UI, lazy load ACE editor --- {...}",
        "outgoing": "DOM (code editor) --- {...}"
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
# Find everything related to WebSocket communication
node scripts/job_tracer.js find WS

# Find all rendering operations
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN JOB_CREATE_DOM_ELEMENT
```

### 🏗️ **Development**: Understand system architecture
```bash
# See all event emission points
node scripts/job_tracer.js trace JOB_EMIT_EVENT

# Find all data validation layers
node scripts/job_tracer.js search JOB_VALIDATE_SCHEMA
```

### 📊 **Analysis**: Identify patterns
```bash
# Which job types are most common?
node scripts/job_tracer.js list --sort frequency

# Export for analysis
node scripts/job_tracer.js export ~/analysis/frontend_arch.json
```

### 🧪 **Testing**: Verify integrations
```bash
# Find all IPC communication points
node scripts/job_tracer.js search JOB_SEND_IPC

# Trace database persistence pipeline
node scripts/job_tracer.js trace JOB_SAVE_TO_DB
```

### 🔐 **Security Audit**: Find security-critical code
```bash
# All input sanitization
node scripts/job_tracer.js search JOB_SANITIZE_HTML JOB_ESCAPE_HTML

# All validation operations
node scripts/job_tracer.js search JOB_VALIDATE_SCHEMA JOB_VALIDATE_IPC_SOURCE
```

---

## Most Common Job Types

Based on our frontend architecture:

| Job Type | Files | Use Case |
|----------|-------|----------|
| `JOB_EMIT_EVENT` | 42 | Event bus communication |
| `JOB_UPDATE_STATE` | 33 | State management |
| `JOB_GET_STATE` | 30 | State retrieval |
| `JOB_VALIDATE_SCHEMA` | 23 | Data validation |
| `JOB_UPDATE_DOM_ELEMENT` | 23 | DOM manipulation |
| `JOB_DELEGATE_TO_MODULE` | 21 | Module coordination |
| `JOB_ROUTE_BY_TYPE` | 19 | Message routing |
| `JOB_INITIALIZE` | 19 | Module initialization |
| `JOB_TRACK_ENTITY` | 18 | Entity tracking |
| `JOB_CREATE_DOM_ELEMENT` | 17 | DOM creation |

---

## Architecture Layers

The tracer organizes files into these layers:

1. **Main Process** - Application orchestration (`src/application/main/`, `src/main/`)
2. **Preload** - Bridge scripts (`src/preload/`)
3. **Artifacts** - Artifacts window (`src/renderer/artifacts/`)
4. **Chat** - Chat window (`src/renderer/chat/`)
5. **Settings** - Settings UI (`src/renderer/settings/`)
6. **Models** - Model management (`src/renderer/models/`)
7. **Shared UI** - Shared components (`src/renderer/shared/`)
8. **Domain Layer** - Business logic (`src/domain/`)
9. **API Client** - HTTP client (`src/infrastructure/api/`)
10. **WebSocket** - WebSocket client (`src/infrastructure/websocket/`)
11. **IPC** - IPC bridge (`src/infrastructure/ipc/`)
12. **Persistence** - Storage layer (`src/infrastructure/persistence/`)
13. **Infrastructure** - Core infrastructure (`src/infrastructure/`)
14. **Scripts** - Build/utility scripts (`scripts/`)

---

## Frontend Job Categories

The frontend uses categorized job types defined in `.architecture/job_types.yaml`:

### Network Jobs
- `JOB_WS_CONNECT`, `JOB_SEND_WS`, `JOB_HTTP_REQUEST`

### Data Transformation
- `JOB_PARSE_JSON`, `JOB_STRINGIFY_JSON`, `JOB_RESTORE_ID`, `JOB_ACCUMULATE_TEXT`

### Validation
- `JOB_VALIDATE_SCHEMA`, `JOB_VALIDATE_IPC_SOURCE`, `JOB_DEDUPLICATE_CHUNK`

### Sanitization
- `JOB_ESCAPE_HTML`, `JOB_SANITIZE_MARKDOWN`, `JOB_SANDBOX_IFRAME`

### ID Generation
- `JOB_GENERATE_SESSION_ID`, `JOB_GENERATE_USER_MSG_ID`, `JOB_GENERATE_ASSISTANT_MSG_ID`

### Routing
- `JOB_ROUTE_BY_TYPE`, `JOB_EMIT_EVENT`, `JOB_SEND_IPC`, `JOB_DELEGATE_TO_MODULE`

### Rendering
- `JOB_RENDER_MARKDOWN`, `JOB_CREATE_DOM_ELEMENT`, `JOB_UPDATE_DOM_ELEMENT`

### Persistence
- `JOB_SAVE_TO_DB`, `JOB_LOAD_FROM_DB`, `JOB_UPDATE_DB`, `JOB_CACHE_LOCALLY`

### State Management
- `JOB_UPDATE_STATE`, `JOB_GET_STATE`, `JOB_CLEAR_STATE`, `JOB_TRACK_ENTITY`

### Lifecycle
- `JOB_INITIALIZE`, `JOB_START`, `JOB_STOP`, `JOB_DISPOSE`

### Stream Control
- `JOB_DETECT_NEW_STREAM`, `JOB_FINALIZE_STREAM`, `JOB_CANCEL_STREAM`

---

## JSON Output Mode

Add `--json` flag to search command:

```bash
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN --json
```

Output:
```json
{
  "query": ["JOB_RENDER_MARKDOWN"],
  "matchMode": "any",
  "totalResults": 4,
  "results": [
    {
      "file": "src/renderer/artifacts/modules/code/CodeViewer.js",
      "jobs": ["JOB_CREATE_DOM_ELEMENT", "JOB_RENDER_MARKDOWN", ...],
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
node scripts/job_tracer.js find stream

# 2. Trace specific one
node scripts/job_tracer.js trace JOB_FINALIZE_STREAM
```

### 🔗 **Follow the Pipeline**
Look at the data flow in trace output:
- **Incoming** → What data/files call this?
- **Processing** → What functions/jobs run?
- **Outgoing** → Where does data go next?

### 🔍 **Use AND/OR Logic Strategically**
```bash
# OR: Files with EITHER job (broader)
node scripts/job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA

# AND: Files with BOTH jobs (narrower)
node scripts/job_tracer.js search JOB_PARSE_JSON JOB_VALIDATE_SCHEMA --all
```

### 📊 **Export for Documentation**
```bash
# Generate architecture documentation
node scripts/job_tracer.js export docs/architecture_index.json

# Process with jq for reports
cat docs/architecture_index.json | jq '.jobTypes | length'
```

---

## Integration Examples

### CI/CD Pipeline
```yaml
# .github/workflows/architecture-check.yml
- name: Verify Architecture Documentation
  run: |
    node scripts/job_tracer.js export arch.json
    node scripts/validate_arch.js arch.json
```

### Pre-commit Hook
```bash
#!/bin/bash
# .git/hooks/pre-commit
node scripts/job_tracer.js export /tmp/arch_check.json
if [ $? -ne 0 ]; then
  echo "❌ Architecture scan failed"
  exit 1
fi
```

### Documentation Generation
```javascript
const fs = require('fs');

// Load architecture
const arch = JSON.parse(fs.readFileSync('architecture_index.json'));

// Generate markdown
for (const jobType of arch.jobTypes.sort()) {
  const files = arch.jobIndex[jobType];
  console.log(`## ${jobType}\n`);
  files.forEach(file => {
    console.log(`- \`${file.file}\``);
  });
}
```

---

## Performance

- **Scan time**: ~1s for 142 files
- **Memory usage**: <100MB
- **JSON export**: ~800KB
- **Regex-based parsing**: Fast and reliable

---

## Troubleshooting

### No files found?
```bash
# Verify @.architecture documentation exists
grep -r "@.architecture" src --include="*.js" --include="*.jsx" | wc -l
# Should show 142
```

### Wrong frontend directory?
```bash
# Script auto-detects from scripts/ location
# Or set manually:
cd /path/to/aether-frontend
node scripts/job_tracer.js list
```

### Job type not found?
```bash
# Use fuzzy search to find similar
node scripts/job_tracer.js find <partial_name>
```

---

## Comparison: Backend vs Frontend

| Aspect | Backend (Python) | Frontend (JavaScript) |
|--------|------------------|----------------------|
| **Files** | 91 | 142 |
| **Job Types** | 261 | 292 |
| **Job Format** | snake_case (e.g., `health_checking`) | SCREAMING_SNAKE (e.g., `JOB_EMIT_EVENT`) |
| **Layers** | 13 | 14 |
| **Language** | Python 3.8+ | Node.js |
| **Most Common** | `health_checking` (12 files) | `JOB_EMIT_EVENT` (42 files) |

---

## Future Enhancements

Potential additions:
- **Call graph visualization** (D3.js/Mermaid integration)
- **Dependency analysis** (which files depend on which)
- **Change impact analysis** (what breaks if file changes)
- **Performance hotspot detection** (most-called jobs)
- **Interactive web UI** (browse architecture visually)
- **Cross-reference with backend** (full-stack pipeline tracing)

---

## Related Tools

- `scripts/job_tracer.js` - This tool (frontend)
- `../aether-backend/scripts/job_tracer.py` - Backend equivalent
- `.architecture/*.yaml` - Architecture standards

---

## Support

For issues or questions:
1. Check `@.architecture` documentation in source files
2. Review `.architecture/*.yaml` standards
3. Run with `--help` for command reference

---

**Built with ❤️ for the Aether Frontend**

