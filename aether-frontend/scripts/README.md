# Frontend Scripts

Production-ready utilities for Aether Frontend operations, analysis, and development.

---

## 📜 Available Scripts

### 1. **job_tracer.js** - Job Type Pipeline Tracer 🆕
**Purpose**: Trace JOB_* types across the entire frontend architecture using `@.architecture` documentation.

**Features**:
- Index and search 292 unique job types across 142 frontend files
- Trace complete data flow pipelines (Incoming → Processing → Outgoing)
- Fuzzy search for related job types
- Export architecture as structured JSON
- Layer-by-layer visualization (14 architectural layers)

**Quick Start**:
```bash
# List all job types
node scripts/job_tracer.js list --sort frequency

# Search for files implementing a job type
node scripts/job_tracer.js search JOB_RENDER_MARKDOWN

# Trace complete pipeline
node scripts/job_tracer.js trace JOB_EMIT_EVENT

# Fuzzy search
node scripts/job_tracer.js find render

# Export to JSON
node scripts/job_tracer.js export architecture_index.json
```

**Common Use Cases**:
- 🔍 **Debugging**: Find all files involved in a feature
- 🏗️ **Development**: Understand system architecture
- 📊 **Analysis**: Identify patterns and dependencies
- 🧪 **Testing**: Verify integrations
- 🔐 **Security Audit**: Find security-critical code

**Documentation**: See [JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md) for comprehensive guide.

---

## 🔄 Workflow Integration

### Pre-Commit Hooks
```bash
# .git/hooks/pre-commit
#!/bin/bash
node scripts/job_tracer.js export /tmp/arch_check.json || exit 1
```

### CI/CD Pipeline
```yaml
# .github/workflows/frontend-tests.yml
- name: Architecture Verification
  run: node scripts/job_tracer.js export arch.json

- name: Validate Documentation
  run: node scripts/validate_arch.js arch.json
```

### Development Workflow
```bash
# Before starting new feature
node scripts/job_tracer.js find <feature_keyword>

# Understand related files
node scripts/job_tracer.js trace JOB_<RELATED_TYPE>

# After changes, verify impact
node scripts/job_tracer.js search JOB_<MODIFIED_TYPE>
```

---

## 📊 Architecture Documentation

All scripts follow the `@.architecture` documentation standard:

```javascript
/**
 * @.architecture
 * 
 * Incoming: <source files> --- {<data types>}
 * Processing: <actions> --- {N jobs: JOB_X, JOB_Y, ...}
 * Outgoing: <destination files> --- {<output types>}
 */
```

This enables the **job_tracer.js** tool to automatically index and trace all scripts!

---

## 🎯 Common Tasks

### New Developer Onboarding
```bash
# Understand the architecture
node scripts/job_tracer.js list --sort frequency

# See event emission patterns
node scripts/job_tracer.js trace JOB_EMIT_EVENT

# Understand state management
node scripts/job_tracer.js search JOB_UPDATE_STATE JOB_GET_STATE
```

### Debugging Production Issues
```bash
# Find all files handling a specific operation
node scripts/job_tracer.js search JOB_<OPERATION>

# Trace data flow
node scripts/job_tracer.js trace JOB_ROUTE_BY_TYPE

# Find WebSocket communication points
node scripts/job_tracer.js find WS
```

### Security Audit
```bash
# Find all input sanitization
node scripts/job_tracer.js search JOB_SANITIZE_HTML JOB_ESCAPE_HTML

# Find all validation
node scripts/job_tracer.js search JOB_VALIDATE_SCHEMA JOB_VALIDATE_IPC_SOURCE

# Export for analysis
node scripts/job_tracer.js export security_audit.json
```

### Performance Analysis
```bash
# Find most common job types
node scripts/job_tracer.js list --sort frequency

# Trace rendering pipeline
node scripts/job_tracer.js trace JOB_RENDER_MARKDOWN

# Export metrics
node scripts/job_tracer.js export metrics.json
```

---

## 🛠️ Development Guidelines

### Adding New Scripts

1. **Follow naming convention**: `<action>_<target>.js`
2. **Add `@.architecture` documentation** at the top
3. **Include docstrings** for all functions
4. **Make executable**: `chmod +x scripts/your_script.js`
5. **Update this README**
6. **Add tests** if applicable

### Script Template
```javascript
#!/usr/bin/env node
'use strict';

/**
 * @.architecture
 * 
 * Incoming: <sources> --- {<types>}
 * Processing: <actions> --- {N jobs: JOB_X, JOB_Y, ...}
 * Outgoing: <destinations> --- {<types>}
 * 
 * Script Title - Brief Description
 * ==================================================
 * Longer description of what the script does.
 */

// Implementation
async function main() {
  // Your code here
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
```

---

## 📖 Related Documentation

- **[JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md)** - Comprehensive job tracer guide
- **[../.architecture/](../.architecture/)** - Architecture standards
  - `file_analysis_directive.yaml` - File documentation rules
  - `data_flow_standard.yaml` - Data flow patterns
  - `job_types.yaml` - All job type definitions
  - `data_types.yaml` - Data type definitions

---

## 🚀 Quick Reference

| Task | Command |
|------|---------|
| **Find files by job type** | `node scripts/job_tracer.js search JOB_<TYPE>` |
| **Trace pipeline** | `node scripts/job_tracer.js trace JOB_<TYPE>` |
| **List all job types** | `node scripts/job_tracer.js list --sort frequency` |
| **Fuzzy search** | `node scripts/job_tracer.js find <keyword>` |
| **Export architecture** | `node scripts/job_tracer.js export arch.json` |

---

## 📈 Statistics

Current frontend metrics:
- **142** production JavaScript/TypeScript files documented
- **292** unique job types identified
- **14** architectural layers
- **1** production-ready script
- **82%** architecture documentation coverage (141/172 files)

---

## 🔧 Troubleshooting

### Script won't run
```bash
# Make executable
chmod +x scripts/*.js

# Check Node.js version (requires 14+)
node --version
```

### Module errors
```bash
# Ensure correct working directory
cd /path/to/aether-frontend

# Install dependencies if needed
npm install
```

### Permission denied
```bash
# Run with appropriate permissions
node scripts/script_name.js
```

---

## 🎓 Learning Resources

1. **Understanding the Architecture**: Start with `node scripts/job_tracer.js list --sort frequency`
2. **Common Patterns**: See [JOB_TRACER_GUIDE.md](JOB_TRACER_GUIDE.md)
3. **Data Flow**: Trace with `node scripts/job_tracer.js trace JOB_<TYPE>`
4. **Job Definitions**: Review `.architecture/job_types.yaml`

---

## 🔗 Backend Integration

The frontend job tracer complements the backend tracer:

| Aspect | Backend | Frontend |
|--------|---------|----------|
| **Tool** | `scripts/job_tracer.py` | `scripts/job_tracer.js` |
| **Language** | Python 3.8+ | Node.js 14+ |
| **Files** | 91 | 142 |
| **Job Types** | 261 | 292 |
| **Format** | snake_case | JOB_* constants |

For full-stack pipeline tracing:
1. Use backend tracer to trace server-side operations
2. Use frontend tracer to trace client-side operations
3. Connect via WebSocket/HTTP job types

---

## 📚 Job Type Categories

Frontend job types are organized into categories:

- **Network** (4 types): WebSocket, HTTP communication
- **Transform** (6 types): JSON parsing, data transformation
- **Validation** (3 types): Schema validation, source checking
- **Sanitization** (3 types): HTML escaping, markdown sanitization
- **ID Generation** (4 types): Session IDs, message IDs
- **Routing** (4 types): Message routing, event emission
- **Rendering** (5 types): DOM creation, markdown rendering
- **Persistence** (4 types): Database operations, caching
- **State** (4 types): State management, entity tracking
- **Lifecycle** (4 types): Module lifecycle management
- **Stream Control** (3 types): Stream management

---

## 🎬 Example Workflows

### Feature Development
```bash
# 1. Understand existing patterns
node scripts/job_tracer.js find <feature_keyword>

# 2. Identify affected files
node scripts/job_tracer.js search JOB_<RELATED_TYPE>

# 3. Trace data flow
node scripts/job_tracer.js trace JOB_<KEY_TYPE>

# 4. Document new code with @.architecture
# (See .architecture/file_analysis_directive.yaml)

# 5. Verify documentation
node scripts/job_tracer.js search JOB_<NEW_TYPE>
```

### Bug Investigation
```bash
# 1. Find all files handling the operation
node scripts/job_tracer.js search JOB_<OPERATION>

# 2. Trace complete pipeline
node scripts/job_tracer.js trace JOB_<OPERATION>

# 3. Review incoming/outgoing data flows
# (Check trace output for data types)

# 4. Export for detailed analysis
node scripts/job_tracer.js export bug_analysis.json
```

### Code Review
```bash
# 1. Verify changed files have @.architecture
grep -l "@.architecture" path/to/changed/files

# 2. Check job types are valid
# (Compare with .architecture/job_types.yaml)

# 3. Trace impact
node scripts/job_tracer.js search JOB_<MODIFIED_TYPES>

# 4. Export architecture snapshot
node scripts/job_tracer.js export review_$(date +%Y%m%d).json
```

---

**Maintained by the Aether Frontend Team**  
Last Updated: November 2025

