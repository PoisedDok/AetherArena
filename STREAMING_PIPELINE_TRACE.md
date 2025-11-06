# Streaming Pipeline Trace - Message Duplication Fix

**Date**: 2025-11-06  
**Status**: ✅ FIXED  
**Root Cause**: EventEmitter collision in `GuruConnection.js`  
**Fix**: One-line guard in message emission logic

---

## EXECUTIVE SUMMARY

**Problem**: Assistant responses appeared twice ("HiHi" instead of "Hi"), duplicate "Stream started/ended" logs.

**Root Cause**: `GuruConnection.emit()` was emitting the `'message'` event twice when `payload.type === 'message'`:
1. Line 328: `this.emit('message', payload)` — explicit generic emission
2. Line 332: `this.emit(payload.type, payload)` — when `payload.type === 'message'`, duplicates line 328

**Fix**: Added guard at line 331: `&& payload.type !== 'message'`

---

## COMPLETE STREAMING PIPELINE

### 1. BACKEND: Message Generation
```
File: aether-backend/core/runtime/streaming.py
Lines: 130-220

ENTRY POINT: RuntimeEngine.stream_chat(request_id, message, chatId, profile)
├─ Initialize interpreter with profile
├─ Send start marker to frontend (line 151)
│  {role: 'assistant', type: 'message', start: true, id: request_id}
├─ Stream OI chunks (async generator)
│  ├─ Filter OI's native start markers (line 192-193)
│  │  → continue (skip entirely)
│  ├─ Filter OI's native end markers (line 197-200)
│  │  → continue (skip entirely, set sent_end flag)
│  └─ Forward content chunks (line 204-211)
│     {role: 'assistant', type: 'message', content: chunk, id: request_id}
└─ Send end marker if not sent (line 220)
   {role: 'assistant', type: 'message', end: true, id: request_id}

Jobs: streaming, message_generation, marker_filtering
```

### 2. BACKEND: WebSocket Relay
```
File: aether-backend/ws/handlers.py  
Lines: 200-350

ENTRY POINT: StreamRelay.relay_stream(client_id, request_id, stream_generator)
├─ Wrap stream generator
├─ For each chunk from streaming.py:
│  ├─ Validate via Pydantic (ws/protocols.py)
│  ├─ Convert to JSON string
│  └─ Send via WebSocket
│     ws.send_text(json.dumps(chunk))
└─ Send completion signal (line 340)
   {role: 'server', type: 'completion', id: request_id}

Jobs: stream_relay, data_validation, message_routing, websocket_send
```

### 3. FRONTEND: WebSocket Reception
```
File: aether-frontend/src/core/communication/GuruConnection.js  
Lines: 272-343

ENTRY POINT: WebSocket.onmessage → _handleMessage(event)
├─ Parse JSON (line 277)
├─ Handle ping/pong (lines 284-295)
├─ Restore frontend_id → id mapping (lines 316-324)
│  Backend echoes frontend_id for correlation
├─ EMIT EVENTS (lines 327-343) **[FIX APPLIED HERE]**
│  ├─ Generic emission (line 329)
│  │  this.emit('message', payload)
│  │  → ALWAYS emits for ALL messages
│  │
│  └─ Type-specific emission (lines 331-340) **[FIXED]**
│     if (payload.type && payload.type !== 'message') {  ← GUARD ADDED
│       this.emit(payload.type, payload);
│       → Only emits if type !== 'message'
│       → Prevents duplicate 'message' emissions
│     }
│
│     BEFORE FIX:
│       if (payload.type) {
│         this.emit(payload.type, payload);  ← Bug when type='message'
│       }
│
└─ Error handling (line 341-343)

Jobs: JOB_WS_RECEIVE, JOB_PARSE_JSON, JOB_RESTORE_ID, JOB_EMIT_EVENT, JOB_ROUTE_BY_TYPE
```

### 4. FRONTEND: Message Manager
```
File: aether-frontend/src/renderer/chat/modules/messaging/MessageManager.js  
Lines: 246-381

ENTRY POINT: GuruConnection.on('message') → _setupWebSocketListeners()
├─ Single listener registered (line 253)
│  endpoint.connection.on('message', (payload) => {
│    this._handleWebSocketMessage(payload);
│  });
│
├─ Handle incoming message (line 265-381)
│  try {
│    const { role, type, content, start, end, id } = payload;
│    
│    // Artifact routing
│    if (role === 'assistant' && type === 'code') → artifacts
│    if (role === 'computer' && type === 'console') → artifacts
│    
│    // Message streaming
│    if (role === 'assistant' && type === 'message') {
│      if (start) {
│        console.log(`Stream started: ${id}`);  ← NOW LOGS ONCE
│        streamHandler.processChunk({ id, chunk: '', start: true });
│        return;
│      }
│      
│      if (end) {
│        console.log(`Stream ended: ${id}`);  ← NOW LOGS ONCE
│        streamHandler.processChunk({ id, chunk: '', done: true });
│        return;
│      }
│      
│      if (content) {
│        streamHandler.processChunk({ id, chunk: content });
│      }
│    }
│    
│    // Control messages
│    if (role === 'server' && type === 'completion') → finalize
│    if (role === 'server' && type === 'stopped') → finalize
│  } catch (error) {
│    console.error('Error handling WebSocket message:', error);
│  }
│
└─ Route to submodules
   ├─ streamHandler.processChunk() → StreamHandler.js
   ├─ eventBus.emit('artifact:stream') → ChatController
   └─ trailContainerManager.updateTrail() → DOM

Jobs: JOB_ROUTE_BY_TYPE, JOB_DELEGATE_TO_MODULE, JOB_EMIT_EVENT
```

### 5. FRONTEND: Stream Handler
```
File: aether-frontend/src/renderer/chat/modules/messaging/StreamHandler.js  
Lines: 140-320

ENTRY POINT: processChunk({ id, chunk, start, done })
├─ Detect new request (line 212-232)
│  if (id !== currentRequestId) {
│    await _resetForNewRequest(id);
│    → Finalize previous stream
│    → Generate new messageId via SessionManager
│    → Render new assistant message element
│  }
├─ Accumulate content (line 260-285)
│  this.accumulatedContent += chunk;
│  → Deduplicate via Set tracking
│  → Parse <think> tags
│  → Update DOM via MessageView
├─ Finalize on done (line 247-325)
│  → Save message to PostgreSQL via MessageState
│  → Link artifacts to message
│  → Clear state
└─ Error handling with finalization guard

Jobs: JOB_ACCUMULATE_TEXT, JOB_DEDUPLICATE_CHUNK, JOB_DETECT_NEW_STREAM,
      JOB_FINALIZE_STREAM, JOB_SAVE_TO_DB, JOB_UPDATE_DOM_ELEMENT
```

### 6. FRONTEND: Message View
```
File: aether-frontend/src/renderer/chat/modules/messaging/MessageView.js  
Lines: 120-450

ENTRY POINT: updateMessage(messageId, content)
├─ Find DOM element by messageId
├─ Sanitize content (SecuritySanitizer)
├─ Render markdown (MarkdownRenderer with syntax highlighting)
├─ Update DOM with throttling (max 60fps)
└─ Auto-scroll to bottom

Jobs: JOB_UPDATE_DOM_ELEMENT, JOB_RENDER_MARKDOWN, JOB_SANITIZE_INPUT
```

---

## THE FIX IN DETAIL

### Problem Analysis

**GuruConnection Dual-Channel Design**:
- **Generic channel**: `emit('message', payload)` — all messages
- **Specific channel**: `emit(payload.type, payload)` — type routing (e.g., 'code', 'console', 'completion')

**The Bug**:
```javascript
// GuruConnection.js line 328-332 (BEFORE FIX)
this.emit('message', payload);  // Always emits 'message'

if (payload && payload.type) {
  this.emit(payload.type, payload);  // Emits payload.type
}
```

When `payload.type === 'message'` (assistant text messages):
1. Line 328: `emit('message', payload)` ← First emission
2. Line 332: `emit('message', payload)` ← **DUPLICATE** (because `payload.type = 'message'`)

**Result**: MessageManager's `connection.on('message', handler)` fired **TWICE** per message.

### The Fix

```javascript
// GuruConnection.js line 328-340 (AFTER FIX)
try {
  // Emit generic message event
  this.emit('message', payload);

  // Emit type-specific events (but not for 'message' type to avoid duplication)
  if (payload && typeof payload === 'object' && payload.type && payload.type !== 'message') {
    this.emit(payload.type, payload);
    
    // Emit 'lmc' events for artifact-related message types
    const artifactTypes = ['code', 'console', 'output', 'html', 'image', 'video'];
    if (artifactTypes.includes(payload.type) || payload.format === 'html') {
      this.emit('lmc', payload);
    }
  }
} catch (error) {
  console.error('[GuruConnection] Error emitting message events:', error);
}
```

**Key Change**: Line 331 guard `&& payload.type !== 'message'`

### Impact

**Before Fix**:
```
[GuruConnection] Received from backend: {type: 'message', start: true, id: 'xxx'}
[GuruConnection] Emitting 'message' (generic)
[MessageManager] Stream started: xxx
[GuruConnection] Emitting 'message' (type-specific)  ← DUPLICATE
[MessageManager] Stream started: xxx  ← DUPLICATE LOG
```

**After Fix**:
```
[GuruConnection] Received from backend: {type: 'message', start: true, id: 'xxx'}
[GuruConnection] Emitting 'message' (generic only)
[MessageManager] Stream started: xxx  ← ONCE
```

---

## SECURITY & ROBUSTNESS IMPROVEMENTS

### Error Handling Added

**GuruConnection.js** (lines 327-343):
```javascript
try {
  this.emit('message', payload);
  // ... type-specific emissions
} catch (error) {
  console.error('[GuruConnection] Error emitting message events:', error);
}
```
→ Prevents listener exceptions from breaking WebSocket

**MessageManager.js** (lines 266-381):
```javascript
_handleWebSocketMessage(payload) {
  try {
    // ... message processing
  } catch (error) {
    console.error('[MessageManager] Error handling WebSocket message:', error, payload);
  }
}
```
→ Graceful degradation on malformed messages

### Architecture Benefits

1. **Single Message Path**: Backend WS → GuruConnection → MessageManager (direct)
2. **No IPC Relay**: Chat window uses direct WebSocket, IPC only for control signals
3. **Clean Separation**: Main window (visualizer), Chat window (self-sufficient), Artifacts window (event bus routing)
4. **Performance**: No redundant processing, no duplicate state tracking

---

## DATA FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────────┐
│ BACKEND                                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  RuntimeEngine.stream_chat()                                     │
│  └─ core/runtime/streaming.py                                   │
│     ├─ Send start marker (line 151)                             │
│     ├─ Filter OI markers (lines 192-200)                        │
│     ├─ Stream content chunks                                    │
│     └─ Send end marker (line 220)                               │
│                                                                   │
│  StreamRelay.relay_stream()                                      │
│  └─ ws/handlers.py                                              │
│     ├─ Validate via Pydantic                                    │
│     └─ Send via WebSocket                                       │
│                    ↓                                              │
└───────────────────┼──────────────────────────────────────────────┘
                    │ WebSocket (ws://localhost:8765)
                    │
┌───────────────────┼──────────────────────────────────────────────┐
│ FRONTEND          ↓                                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  GuruConnection._handleMessage()                                 │
│  └─ core/communication/GuruConnection.js                        │
│     ├─ Parse JSON (line 277)                                    │
│     ├─ Restore frontend_id mapping (line 320)                   │
│     └─ EMIT EVENTS (lines 327-340) **[FIX HERE]**              │
│        ├─ emit('message', payload) ← generic (ALWAYS)           │
│        └─ if (type !== 'message')   ← guard prevents duplicate  │
│             emit(payload.type, payload) ← type-specific         │
│                    ↓                                              │
│                    │ EventEmitter                                │
│                    ↓                                              │
│  MessageManager._handleWebSocketMessage()                        │
│  └─ renderer/chat/modules/messaging/MessageManager.js           │
│     ├─ Route artifacts → ChatController → Artifacts window      │
│     ├─ Handle message start/end (NOW ONCE)                      │
│     └─ Forward chunks → StreamHandler                           │
│                    ↓                                              │
│  StreamHandler.processChunk()                                    │
│  └─ renderer/chat/modules/messaging/StreamHandler.js            │
│     ├─ Detect new stream                                        │
│     ├─ Accumulate content                                       │
│     ├─ Update DOM via MessageView                               │
│     └─ Finalize → save to PostgreSQL                            │
│                    ↓                                              │
│  MessageView.updateMessage()                                     │
│  └─ renderer/chat/modules/messaging/MessageView.js              │
│     ├─ Sanitize content                                         │
│     ├─ Render markdown                                          │
│     └─ Update DOM (throttled 60fps)                             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## JOB TYPE TRACEABILITY

### Backend Jobs
- **streaming** (core/runtime/streaming.py, utils/http.py, api/v1/endpoints/chat.py)
- **stream_relay** (ws/handlers.py)
- **message_routing** (ws/handlers.py)
- **data_validation** (ws/handlers.py, api/v1/endpoints/chat.py)

### Frontend Jobs
- **JOB_WS_RECEIVE** (GuruConnection.js)
- **JOB_EMIT_EVENT** (GuruConnection.js, MessageManager.js, StreamHandler.js)
- **JOB_ROUTE_BY_TYPE** (GuruConnection.js, MessageManager.js)
- **JOB_DELEGATE_TO_MODULE** (MessageManager.js, StreamHandler.js)
- **JOB_ACCUMULATE_TEXT** (StreamHandler.js)
- **JOB_UPDATE_DOM_ELEMENT** (StreamHandler.js, MessageView.js)
- **JOB_SAVE_TO_DB** (StreamHandler.js → MessageState.js)
- **JOB_RENDER_MARKDOWN** (MessageView.js)

---

## VERIFICATION RESULTS

✅ **Build successful** (frontend rebuilt, no errors)  
✅ **No linter errors** (both frontend and backend)  
✅ **Core fix preserved** (`payload.type !== 'message'` guard in place)  
✅ **Error handling added** (try-catch in GuruConnection and MessageManager)  
✅ **Production-ready comments** (removed debug noise, kept critical notes)  
✅ **Single "Stream started" log per message**  
✅ **Single "Stream ended" log per message**  
✅ **No "HiHi" duplication** — responses display correctly  
✅ **Clean console** — no duplicate warnings  

---

## FILES MODIFIED

1. **aether-frontend/src/core/communication/GuruConnection.js**
   - Line 331: Added `&& payload.type !== 'message'` guard
   - Lines 327-343: Added try-catch for error resilience
   - Removed debug logs

2. **aether-frontend/src/renderer/chat/modules/messaging/MessageManager.js**
   - Lines 266-381: Added try-catch around message handler
   - Removed debug instance ID tracking
   - Cleaned up IPC listener comments

3. **aether-frontend/src/application/main/UIManager.js**
   - Lines 497-511: Simplified relay comments
   - No functional changes (relay was already disabled)

4. **aether-backend/core/runtime/streaming.py**
   - Lines 191-200: Simplified OI marker skip comments
   - No functional changes (markers already filtered)

---

## CONCLUSION

The streaming pipeline is now **production-ready**, **error-resilient**, and **performance-optimized**. The one-line fix in `GuruConnection.js` eliminated the message duplication bug while preserving the dual-channel EventEmitter design for type-specific routing.

**Architecture**: Clean, well-separated, fully traceable from backend streaming through WebSocket to frontend DOM rendering.

