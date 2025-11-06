# Full-Stack Job Tracer Guide

**Complete Pipeline Tracing** - Trace data flow from Frontend → Backend → Frontend across the entire Aether stack.

---

## 🌐 Overview

The Aether project now has **TWO complementary job tracers** that work together:

1. **Backend Tracer** (`aether-backend/scripts/job_tracer.py`) - Python-based, 261 job types
2. **Frontend Tracer** (`aether-frontend/scripts/job_tracer.js`) - Node.js-based, 298 job types

Together, they provide **complete full-stack pipeline visibility** with 559 unique job types across 233 files!

---

## 📊 Side-by-Side Comparison

| Metric | Backend (Python) | Frontend (JavaScript) |
|--------|------------------|----------------------|
| **Files Documented** | 91 | 142 |
| **Job Types** | 261 | 298 |
| **Layers** | 13 | 14 |
| **Coverage** | 100% | 82% |
| **Job Format** | `snake_case` | `JOB_*` |
| **Most Common** | `health_checking` (12) | `JOB_EMIT_EVENT` (42) |
| **Language** | Python 3.8+ | Node.js 14+ |
| **Scan Time** | ~0.5s | ~1.0s |

---

## 🚀 Quick Start (Both Tracers)

```bash
# Backend
cd AetherArena/aether-backend
./scripts/job_tracer.py list --sort frequency

# Frontend
cd AetherArena/aether-frontend
node scripts/job_tracer.js list --sort frequency
```

---

## 🔗 Full-Stack Pipeline Tracing

### Example 1: WebSocket Chat Message Flow

**Step 1: Trace Frontend WebSocket Sending**
```bash
cd aether-frontend
node scripts/job_tracer.js find WS
# Found: JOB_SEND_WS

node scripts/job_tracer.js trace JOB_SEND_WS
```

**Output:**
```
📄 src/renderer/main/modules/audio/AudioManager.js
⬇️  User interactions (mic button, Space key)
⚙️  MediaRecorder, base64 encode, send via WebSocket
⬆️  Endpoint.connection.send() → Backend STT
```

**Step 2: Trace Backend WebSocket Reception**
```bash
cd ../aether-backend
./scripts/job_tracer.py search message_routing
```

**Output:**
```
📄 ws/handlers.py
⬇️  ws/hub.py, core/runtime/streaming.py
⚙️  handle_json(), handle_binary(), relay_stream()
⬆️  ws/hub.py, Frontend (WebSocket), core/runtime/engine.py
```

**Step 3: Trace Backend Processing**
```bash
./scripts/job_tracer.py trace streaming_orchestration
```

**Output:**
```
📄 core/runtime/engine.py
⬇️  api/v1/endpoints/chat.py, ws/handlers.py
⚙️  stream_chat(), _execute_interpreter()
⬆️  ws/hub.py → Frontend WebSocket
```

**Step 4: Trace Frontend Reception**
```bash
cd ../aether-frontend
node scripts/job_tracer.js search JOB_PARSE_JSON JOB_ROUTE_BY_TYPE --all
```

**Output:**
```
📄 src/core/communication/GuruConnection.js
⬇️  Backend WebSocket (ws://localhost:8765)
⚙️  Parse JSON, restore frontend_id, emit typed events
⬆️  Event 'message' → UIManager.js
```

---

### Example 2: HTTP Settings Update Flow

**Step 1: Frontend Initiates Settings Update**
```bash
cd aether-frontend
node scripts/job_tracer.js search JOB_HTTP_REQUEST
```

**Output:**
```
📄 src/core/communication/ApiClient.js
⬇️  Application modules (SettingsManager.js)
⚙️  Wrap fetch with timeout, retry, circuit breaker
⬆️  Backend REST API (http://localhost:8765/v1/*)
```

**Step 2: Backend Receives HTTP Request**
```bash
cd ../aether-backend
./scripts/job_tracer.py search settings_mutation
```

**Output:**
```
📄 api/v1/endpoints/settings.py
⬇️  Frontend (HTTP POST), config/settings.py
⚙️  update_settings(), reload_settings()
⬆️  SettingsResponse schema, config/settings.py
```

**Step 3: Backend Validates and Persists**
```bash
./scripts/job_tracer.py trace schema_validation
```

**Output:**
```
📄 api/v1/schemas/settings.py
⬇️  api/v1/endpoints/settings.py
⚙️  Pydantic validation and serialization
⬆️  api/v1/endpoints/settings.py
```

---

### Example 3: Health Check Full Cycle

**Frontend Health Check Trigger:**
```bash
cd aether-frontend
node scripts/job_tracer.js trace JOB_CHECK_HEALTH
```

**Backend Health Check Handler:**
```bash
cd ../aether-backend
./scripts/job_tracer.py trace health_checking
```

**Result:** 12 backend files + 7 frontend files handling health checks!

---

## 🎯 Common Full-Stack Scenarios

### 1. **Debugging a Feature End-to-End**

```bash
# Frontend: User action
cd aether-frontend
node scripts/job_tracer.js search JOB_<USER_ACTION>

# Backend: API handler
cd ../aether-backend
./scripts/job_tracer.py search <api_endpoint_job>

# Backend: Processing
./scripts/job_tracer.py trace <core_processing_job>

# Frontend: Response handling
cd ../aether-frontend
node scripts/job_tracer.js search JOB_UPDATE_DOM_ELEMENT
```

### 2. **Security Audit Across Stack**

```bash
# Frontend: Input sanitization
cd aether-frontend
node scripts/job_tracer.js search JOB_SANITIZE_HTML JOB_VALIDATE_SCHEMA

# Backend: Input validation
cd ../aether-backend
./scripts/job_tracer.py search sanitization validation encryption
```

### 3. **Performance Analysis**

```bash
# Frontend: Find most common operations
cd aether-frontend
node scripts/job_tracer.js list --sort frequency | head -20

# Backend: Find most common operations
cd ../aether-backend
./scripts/job_tracer.py list --sort frequency | head -20

# Compare and identify hotspots
```

### 4. **Data Flow Documentation**

```bash
# Export both architectures
cd aether-frontend
node scripts/job_tracer.js export frontend_arch.json

cd ../aether-backend
./scripts/job_tracer.py export backend_arch.json

# Merge for full-stack documentation
python3 merge_architectures.py frontend_arch.json backend_arch.json
```

---

## 🔍 Cross-Reference Communication

### WebSocket Communication

**Frontend Side:**
```bash
node scripts/job_tracer.js find WS
# JOB_SEND_WS, JOB_CONNECT_WS, JOB_RECEIVE_WS
```

**Backend Side:**
```bash
./scripts/job_tracer.py search message_routing streaming
# ws/handlers.py, ws/hub.py, core/runtime/streaming.py
```

### HTTP API Communication

**Frontend Side:**
```bash
node scripts/job_tracer.js search JOB_HTTP_REQUEST
# src/core/communication/ApiClient.js
```

**Backend Side:**
```bash
./scripts/job_tracer.py search request_tracking http_communication
# api/v1/endpoints/*.py
```

### IPC Communication (Electron)

**Frontend Side:**
```bash
node scripts/job_tracer.js search JOB_SEND_IPC JOB_VALIDATE_IPC_SOURCE
# IPC bridge, preload scripts
```

**Backend Side:**
(N/A - IPC is frontend-only between main/renderer processes)

---

## 📈 Statistics Breakdown

### Backend (Python)
- **Files**: 91 production files
- **Job Types**: 261 unique
- **Layers**: 
  - API Endpoints (16)
  - Middleware (3)
  - WebSocket (3)
  - Core Services (25)
  - Data Layer (7)
  - Security (5)
  - Monitoring (4)
  - Utils (5)
  - Config (1)
  - Scripts (4)

### Frontend (JavaScript)
- **Files**: 142 production files
- **Job Types**: 298 unique
- **Layers**:
  - Main Process (10)
  - Preload (2)
  - Artifacts (7)
  - Chat (11)
  - Settings/Models (varies)
  - Shared UI (2)
  - Domain Layer (varies)
  - Infrastructure (varies)

### Combined
- **Total Files**: 233
- **Total Job Types**: 559
- **Total Layers**: 27
- **Documentation Coverage**: 93% average (100% backend, 82% frontend)

---

## 🛠️ Development Workflows

### Adding a New Feature

**Step 1: Research Existing Patterns**
```bash
# Frontend
cd aether-frontend
node scripts/job_tracer.js find <feature_keyword>

# Backend
cd ../aether-backend
./scripts/job_tracer.py find <feature_keyword>
```

**Step 2: Identify Integration Points**
```bash
# Find WebSocket handlers
cd aether-backend
./scripts/job_tracer.py search message_routing

cd ../aether-frontend
node scripts/job_tracer.js search JOB_ROUTE_BY_TYPE
```

**Step 3: Implement & Document**
- Add `@.architecture` to new files
- Follow existing job type patterns
- Verify with tracers

**Step 4: Validate**
```bash
# Verify frontend documentation
cd aether-frontend
node scripts/job_tracer.js search JOB_<NEW_TYPE>

# Verify backend documentation
cd ../aether-backend
./scripts/job_tracer.py search <new_job_type>
```

---

### Debugging Production Issues

**Step 1: Identify Symptoms**
```bash
# Where does error occur?
# Frontend? Backend? Communication?
```

**Step 2: Trace Frontend**
```bash
cd aether-frontend
node scripts/job_tracer.js trace JOB_<SUSPECTED_OPERATION>
```

**Step 3: Trace Backend**
```bash
cd ../aether-backend
./scripts/job_tracer.py trace <suspected_job>
```

**Step 4: Identify Gap**
```bash
# Check data flow between frontend and backend
# Look for mismatched data types or missing handlers
```

---

## 🎓 Learning the Codebase

### For New Developers

**Day 1: Understand Architecture**
```bash
# Backend overview
cd aether-backend
./scripts/job_tracer.py list --sort frequency | head -20

# Frontend overview
cd ../aether-frontend
node scripts/job_tracer.js list --sort frequency | head -20
```

**Day 2: Follow a Request**
```bash
# Pick any endpoint
cd aether-backend
./scripts/job_tracer.py search <endpoint>

# See how frontend calls it
cd ../aether-frontend
node scripts/job_tracer.js search JOB_HTTP_REQUEST
```

**Day 3: Understand State Management**
```bash
# Frontend state
cd aether-frontend
node scripts/job_tracer.js trace JOB_UPDATE_STATE

# Backend state
cd ../aether-backend
./scripts/job_tracer.py search state_management
```

---

## 🔐 Security Auditing

### Complete Security Audit

**Frontend Security:**
```bash
cd aether-frontend
node scripts/job_tracer.js search \
  JOB_SANITIZE_HTML \
  JOB_ESCAPE_HTML \
  JOB_VALIDATE_SCHEMA \
  JOB_VALIDATE_IPC_SOURCE
```

**Backend Security:**
```bash
cd ../aether-backend
./scripts/job_tracer.py search \
  sanitization \
  validation \
  encryption \
  authentication \
  authorization
```

**Cross-Reference:**
- Ensure frontend sanitizes before sending
- Verify backend validates all inputs
- Check encryption for sensitive data
- Confirm auth tokens are properly validated

---

## 📚 CI/CD Integration

### Full-Stack Architecture Validation

```yaml
# .github/workflows/architecture-check.yml
name: Architecture Validation

on: [push, pull_request]

jobs:
  validate-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Validate Backend Architecture
        run: |
          cd aether-backend
          python3 scripts/job_tracer.py export backend_arch.json
          python3 scripts/validate_arch.py backend_arch.json

  validate-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Validate Frontend Architecture
        run: |
          cd aether-frontend
          node scripts/job_tracer.js export frontend_arch.json
          node scripts/validate_arch.js frontend_arch.json

  cross-reference:
    runs-on: ubuntu-latest
    needs: [validate-backend, validate-frontend]
    steps:
      - name: Cross-Reference APIs
        run: |
          python3 scripts/verify_api_compatibility.py \
            aether-backend/backend_arch.json \
            aether-frontend/frontend_arch.json
```

---

## 🎬 Real-World Example

### Scenario: Chat Message Not Rendering

**Step 1: Check Frontend Message Handling**
```bash
cd aether-frontend
node scripts/job_tracer.js trace JOB_CREATE_DOM_ELEMENT
```

**Found:** `MessageView.js` creates chat entries

**Step 2: Check Frontend WebSocket Reception**
```bash
node scripts/job_tracer.js search JOB_PARSE_JSON
```

**Found:** `GuruConnection.js` parses WebSocket messages

**Step 3: Check Backend WebSocket Sending**
```bash
cd ../aether-backend
./scripts/job_tracer.py trace streaming_coordination
```

**Found:** `core/runtime/streaming.py` sends chunks via WebSocket

**Step 4: Check Backend Message Routing**
```bash
./scripts/job_tracer.py search message_routing
```

**Found:** `ws/handlers.py` routes messages

**Result:** Traced complete pipeline, identified that message type wasn't being properly routed!

---

## 🚀 Quick Reference

| Task | Backend Command | Frontend Command |
|------|----------------|------------------|
| **List Jobs** | `./scripts/job_tracer.py list` | `node scripts/job_tracer.js list` |
| **Search** | `./scripts/job_tracer.py search <job>` | `node scripts/job_tracer.js search JOB_<TYPE>` |
| **Trace** | `./scripts/job_tracer.py trace <job>` | `node scripts/job_tracer.js trace JOB_<TYPE>` |
| **Find** | `./scripts/job_tracer.py find <query>` | `node scripts/job_tracer.js find <query>` |
| **Export** | `./scripts/job_tracer.py export arch.json` | `node scripts/job_tracer.js export arch.json` |

---

## 📖 Related Documentation

- **Backend Guide**: `aether-backend/scripts/JOB_TRACER_GUIDE.md`
- **Frontend Guide**: `aether-frontend/scripts/JOB_TRACER_GUIDE.md`
- **Backend README**: `aether-backend/scripts/README.md`
- **Frontend README**: `aether-frontend/scripts/README.md`
- **Architecture Standards**: `.architecture/` folders in both projects

---

## 🎉 Benefits of Full-Stack Tracing

✅ **Complete Visibility** - See data flow from UI click to database write  
✅ **Faster Debugging** - Quickly identify where issues occur  
✅ **Better Onboarding** - New developers understand the system faster  
✅ **Improved Security** - Easy to audit security-critical paths  
✅ **Architecture Documentation** - Self-documenting codebase  
✅ **CI/CD Integration** - Automated architecture validation  
✅ **Cross-Team Communication** - Frontend/backend teams aligned  

---

**Master the Full Stack with Job Tracers!** 🚀

---

*Last Updated: November 2025*  
*Aether Project - Full-Stack Pipeline Tracer*

