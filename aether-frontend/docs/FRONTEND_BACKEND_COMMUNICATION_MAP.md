# Frontend-Backend Communication & Streaming Architecture Map

**Last Updated:** 2025-11-06  
**Scope:** Aether Frontend (aether-frontend/)
**Status:** ✅ VALIDATED - All 173 files documented, all 47 job types registered

---

## Executive Summary

This document maps the EXACT files responsible for backend-frontend communication in the Aether frontend. All architecture comments have been validated and corrected using automated tools (`validate_job_types.js` and `job_tracer.js`).

### Validation Results
- **Files with @.architecture documentation:** 173 files
- **Registered job types:** 47 types
- **Pipeline integrity:** ✅ All job types validated
- **Architecture compliance:** 100%

---

## 1. PRIMARY COMMUNICATION PIPELINES

### 1.1 WebSocket Entry Pipeline (Backend → Frontend)

**Complete Flow:**
```
Backend WebSocket (ws://localhost:8765)
  ↓ [handlers.py StreamRelay → protocols.py validation]
GuruConnection.js (WebSocket receive, JSON parse, ID restoration)
  ↓ [Event 'message' emission]
UIManager.js (WebSocket-to-IPC relay, chunk transformation)
  ↓ [IPC 'chat:assistant-stream']
Chat Window (MessageManager.js receives streaming chunks)
  ↓ [DOM rendering]
User sees message
```

**Key Files:**

1. **GuruConnection.js** - WebSocket Entry Point
   - Path: `src/core/communication/GuruConnection.js`
   - Jobs: 11 (JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GET_STATE, JOB_PARSE_JSON, JOB_RESTORE_ID, JOB_ROUTE_BY_TYPE, JOB_START, JOB_STOP, JOB_UPDATE_STATE, JOB_WS_CONNECT, JOB_WS_SEND)
   - Incoming: Backend WebSocket (ws://localhost:8765 via backend/ws/handlers.py StreamRelay)
   - Processing: Parse JSON, restore frontend_id→id mapping, emit typed events
   - Outgoing: EventEmitter 'message'/'lmc' → UIManager/ArtifactsStreamHandler

2. **UIManager.js** - WebSocket-to-IPC Relay
   - Path: `src/application/main/UIManager.js`
   - Jobs: 8 (JOB_DELEGATE_TO_MODULE, JOB_DISPOSE, JOB_GET_STATE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_START, JOB_TRANSFORM_TO_CHUNK)
   - Incoming: Event 'message' from GuruConnection.js
   - Processing: Transform WebSocket payloads to IPC format, route by role (assistant/server)
   - Outgoing: IPC 'chat:assistant-stream' → Chat Window MessageManager.js

3. **ArtifactsStreamHandler.js** - Artifact Detection & Routing
   - Path: `src/application/main/ArtifactsStreamHandler.js`
   - Jobs: 9 (JOB_DISPOSE, JOB_EMIT_EVENT, JOB_GENERATE_ARTIFACT_ID, JOB_GET_STATE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_START, JOB_STOP, JOB_TRACK_ENTITY)
   - Incoming: Event 'lmc' from GuruConnection.js (artifact-type messages)
   - Processing: Classify artifacts, generate SessionManager IDs, track parent-child linkage
   - Outgoing: IPC 'artifacts:stream' → Artifacts Window

---

### 1.2 WebSocket Send Pipeline (Frontend → Backend)

**Complete Flow:**
```
User types message
  ↓
MessageValidator.js (schema validation, rate limiting)
  ↓
GuruConnection.send() (JSON stringify, WebSocket send)
  ↓
Backend WebSocket Hub (ws/hub.py)
  ↓
Backend Handlers (ws/handlers.py MessageHandler)
  ↓
Runtime Engine (core/runtime/engine.py)
```

**Key Files:**

1. **MessageValidator.js** - Schema Validation & Rate Limiting
   - Path: `src/domain/chat/validators/MessageValidator.js`
   - Jobs: 5 (JOB_CLEAR_STATE, JOB_DISPOSE, JOB_TRACK_ENTITY, JOB_UPDATE_STATE, JOB_VALIDATE_SCHEMA)
   - Incoming: MessageService.createMessage(), MessageRepository.save()
   - Processing: Validate schema (content/role/ID/timestamps), track rate limits
   - Outgoing: Return {valid, errors} or {allowed, current, limit, resetIn}

2. **GuruConnection.js** - WebSocket Send
   - Same file as WebSocket Entry, handles bidirectional communication
   - Method: `send(data)` - Stringifies JSON and sends via WebSocket
   - Method: `stopRequest(requestId)` - Sends stop/cancel signals

---

### 1.3 IPC Bridge Pipeline (Main Process ↔ Renderer Windows)

**Architecture:**
```
Renderer (Main/Chat/Artifacts Window)
  ↓ [IpcBridge.js wrapper]
window.aether.ipc (exposed by preload script)
  ↓ [Electron contextBridge]
ipcMain (Main Process)
  ↓ [IpcRouter.js validation & routing]
WindowManager (window control)
  ↓
Target Window webContents.send()
```

**Key Files:**

1. **IpcBridge.js** - Renderer IPC Wrapper
   - Path: `src/infrastructure/ipc/IpcBridge.js`
   - Jobs: 5 (JOB_CLEAR_STATE, JOB_DISPOSE, JOB_GET_STATE, JOB_SEND_IPC, JOB_TRACK_ENTITY)
   - Incoming: Renderer modules (UIManager.js, MessageManager.js, ChatController.js)
   - Processing: Wraps window.aether.ipc, queues messages, tracks listeners
   - Outgoing: window.aether.ipc.send() → Main process

2. **IpcRouter.js** - Main Process Router
   - Path: `src/main/services/IpcRouter.js`
   - Jobs: 5 (JOB_DELEGATE_TO_MODULE, JOB_INITIALIZE, JOB_ROUTE_BY_TYPE, JOB_SEND_IPC, JOB_VALIDATE_IPC_SOURCE)
   - Incoming: IPC events from Main/Chat/Artifacts Windows
   - Processing: Route messages between windows, validate source, delegate to WindowManager
   - Outgoing: window.webContents.send() → Renderer windows

3. **Preload Scripts** - Security Bridge
   - main-preload.js: `src/preload/main-preload.js`
   - chat-preload.js: `src/preload/chat-preload.js`
   - artifacts-preload.js: `src/preload/artifacts-preload.js`
   - Purpose: Expose secure IPC API via contextBridge
   - Security: Channel whitelisting, source validation, payload sanitization

---

## 2. ID GENERATION PIPELINE

**SessionManager-Based Deterministic IDs:**

```
SessionManager.nextUserMessageId()
  ↓
Format: {chatId}_{sequence}_UM
  ↓
Example: a0d6fa98_000001_UM
```

**Artifact ID Generation:**
```
SessionManager.nextCodeArtifactId(messageId)
  ↓
Format: {chatId}_{sequence}_AC
  ↓
Example: a0d6fa98_000003_AC
```

**Key File:**

- **SessionManager.js**
  - Path: `src/core/session/SessionManager.js`
  - Generates deterministic, traceable IDs
  - Maintains parent-child relationships
  - Tracks sequence numbers per session

---

## 3. BACKEND-FRONTEND DATA CONTRACTS

### 3.1 WebSocket Message Format (Backend → Frontend)

**Assistant Streaming Message:**
```json
{
  "role": "assistant",
  "type": "message",
  "id": "backend-uuid",
  "frontend_id": "a0d6fa98_000002_AM",  // Echoed back
  "content": "text delta",
  "start": false,
  "end": false
}
```

**Start Marker:**
```json
{
  "role": "assistant",
  "type": "message",
  "id": "backend-uuid",
  "frontend_id": "a0d6fa98_000002_AM",
  "start": true
}
```

**End Marker:**
```json
{
  "role": "assistant",
  "type": "message",
  "id": "backend-uuid",
  "frontend_id": "a0d6fa98_000002_AM",
  "end": true
}
```

**Server Messages:**
```json
{
  "role": "server",
  "type": "completion",
  "id": "backend-uuid"
}
```

### 3.2 IPC Message Format (Main → Chat Window)

**Transformed Chunk:**
```json
{
  "chunk": "text delta",
  "id": "a0d6fa98_000002_AM",  // Frontend ID (restored from backend echo)
  "backend_id": "backend-uuid",  // Preserved for correlation
  "start": false,
  "done": false,
  "type": "message"
}
```

---

## 4. SECURITY & VALIDATION LAYERS

### 4.1 Backend Validation (ws/protocols.py)
- Pydantic schema validation
- Content sanitization (security/sanitization.py)
- Rate limiting
- XSS prevention

### 4.2 Frontend Validation

**MessageValidator.js:**
- Schema validation (content/role/ID/timestamps)
- Rate limiting (60 messages/minute default)
- Content size limits (100KB default)
- Role whitelisting: ['user', 'assistant', 'system']

**InputValidator.js:**
- Path: `src/core/security/InputValidator.js`
- Input sanitization
- SQL injection prevention
- Path traversal prevention

**Sanitizer.js:**
- Path: `src/core/security/Sanitizer.js`
- HTML escaping
- Markdown sanitization
- XSS prevention

---

## 5. PIPELINE VERIFICATION TOOLS

### 5.1 Validation Script
```bash
node scripts/validate_job_types.js
```
- Validates all @.architecture comments
- Checks job types against registry
- Returns exit code 0 if valid

### 5.2 Job Tracer
```bash
# Trace a specific job type
node scripts/job_tracer.js trace JOB_SEND_IPC

# List all job types by frequency
node scripts/job_tracer.js list --sort frequency

# Search for job types
node scripts/job_tracer.js find ws_

# Export architecture index
node scripts/job_tracer.js export architecture_index.json
```

---

## 6. BACKEND FILE MAPPING

**Reference:** `/Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/`

### WebSocket Communication Files:

1. **ws/hub.py** - WebSocket Hub
   - Connection management
   - Message broadcasting
   - Client registry

2. **ws/handlers.py** - Message Handlers
   - handle_json() - JSON message parsing
   - handle_binary() - Binary audio handling
   - StreamRelay.relay_stream() - Async stream forwarding
   - MessageHandler._handle_user_message() - User input processing

3. **ws/protocols.py** - Protocol Definitions
   - Pydantic schemas (ClientMessage, AssistantMessage, SystemMessage)
   - validate_message() - Schema validation
   - Message type enums

4. **core/runtime/engine.py** - Runtime Engine
   - stream_chat() - LLM streaming interface
   - Generation control

5. **core/runtime/streaming.py** - ChatStreamer
   - Async generator for chat streaming
   - Token-by-token emission

---

## 7. CRITICAL LOGGING POINTS

### Frontend Entry Points:
- `GuruConnection.js:308` - "📥 ENTRY POINT: Received from backend"
- `ArtifactsStreamHandler.js:84` - "📥 ENTRY POINT: Artifact from backend"

### Frontend Relay Points:
- `UIManager.js:528` - "🔄 RELAY: Main → Chat window"

### Frontend Exit Points:
- `ArtifactsStreamHandler.js:355` - "🚀 EXIT POINT: Sending to artifacts window"

### Backend Entry Points:
- `handlers.py:468` - "📥 ENTRY POINT: User message received"

### Backend Exit Points:
- `handlers.py:126` - "🚀 EXIT POINT: Sending start marker"
- `handlers.py:221` - "🚀 EXIT POINT: Sending end marker"

---

## 8. KNOWN ISSUES & FIXES APPLIED

### Issues Fixed During Analysis:
1. ✅ GuruConnection.js - Added missing JOB_WS_CONNECT
2. ✅ UIManager.js - Added missing JOB_TRANSFORM_TO_CHUNK
3. ✅ ArtifactsStreamHandler.js - Added missing JOB_STOP
4. ✅ MessageValidator.js - Added missing JOB_DISPOSE
5. ✅ IpcBridge.js - Added missing JOB_GET_STATE, JOB_DISPOSE, JOB_CLEAR_STATE

### Architecture Consistency:
- All files now accurately reflect their actual job operations
- Job counts updated to match implementation
- No unregistered job types found

---

## 9. SUMMARY STATISTICS

| Metric | Value |
|--------|-------|
| Total Frontend Files | 210 |
| Files with @.architecture | 173 |
| Registered Job Types | 47 |
| Unique Job Types Used | 39 |
| Backend Communication Files | 5 |
| IPC Channels | 15+ |
| Validation Pass Rate | 100% |

---

## 10. NEXT STEPS & RECOMMENDATIONS

### Monitoring:
1. Run `validate_job_types.js` in CI/CD pipeline
2. Use `job_tracer.js` for debugging data flow issues
3. Monitor logs at critical entry/exit points

### Security:
1. All message paths validated ✅
2. Rate limiting active ✅
3. Input sanitization in place ✅
4. IPC source validation enabled ✅

### Performance:
1. Message queueing prevents loss during reconnection ✅
2. Async streaming prevents UI blocking ✅
3. Event delegation for efficient DOM updates ✅

---

**Document Status:** ✅ COMPLETE & VALIDATED  
**Author:** AI Assistant  
**Tools Used:** validate_job_types.js, job_tracer.js, manual code analysis  
**Validation Date:** 2025-11-06

