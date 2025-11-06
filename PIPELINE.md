# Aether Pipeline Flow

## 📊 BACKEND → FRONTEND (Artifacts Pipeline)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘

ws/handlers.py::relay_stream()
  ⬇ Incoming:  core/runtime/streaming.py (streaming chat chunks from RuntimeEngine)
  ⚙ Processing: relay_stream(), handle_json(), stream_relay
  ⬆ Outgoing:   Frontend (WebSocket), streaming responses to clients

                              ↓ WebSocket

┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND - MAIN PROCESS                                                     │
└─────────────────────────────────────────────────────────────────────────────┘

core/communication/GuruConnection.js::_handleMessage()
  ⬇ Incoming:  Backend WebSocket (ws://localhost:8765)
  ⚙ Processing: Parse JSON, restore frontend_id→id, emit typed events
  ⬆ Outgoing:   EventEmitter 'message'/'lmc' → MainOrchestrator/ArtifactsStreamHandler

                              ↓ Event 'lmc'

application/main/ArtifactsStreamHandler.js::handleStream()
  ⬇ Incoming:  Event 'lmc' from GuruConnection (role=assistant|computer, type=code|console|html)
  ⚙ Processing: Classify artifact, generate SessionManager IDs, track parent-child linkage
  ⬆ Outgoing:   IPC 'artifacts:stream' → Artifacts Window, EventBus ARTIFACTS.STREAM

                              ↓ IPC

┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND - CHAT WINDOW                                                      │
└─────────────────────────────────────────────────────────────────────────────┘

renderer/chat/controllers/ChatController.js::_handleArtifactStream()
  ⬇ Incoming:  EventBus 'artifact:stream' (from MessageManager via WebSocket)
  ⚙ Processing: Enrich with chatId from messageManager.messageState.currentChatId
  ⬆ Outgoing:   window.aether.artifacts.streamReady() (artifact + chatId)

                              ↓ EventBus

renderer/chat/modules/messaging/MessageManager.js::_updateTrailWithArtifact()
  ⬇ Incoming:  WebSocket artifacts (role, type, format, start/end)
  ⚙ Processing: Route to StreamHandler, create TRAIL visualization, track execution phases
  ⬆ Outgoing:   streamHandler.processChunk(), trailContainerManager.addExecutionToTrail()

                              ↓ Parallel: Artifacts Window + TRAIL Container

┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND - ARTIFACTS WINDOW                                                 │
└─────────────────────────────────────────────────────────────────────────────┘

renderer/artifacts/renderer.js::handleArtifactStream()
  ⬇ Incoming:  IPC 'artifacts:stream' (from artifacts-preload.js)
  ⚙ Processing: Track streaming artifacts in Map, accumulate content (start→content→end)
  ⬆ Outgoing:   DOM updates (code/output tabs), tab switches

                              ↓ Stream accumulation

renderer/artifacts/renderer.js::_finalizeArtifact()
  ⬇ Incoming:  Completed stream (end=true)
  ⚙ Processing: Create artifact record with chatId/messageId linkage
  ⬆ Outgoing:   artifacts registry, display in CodeViewer/OutputViewer

┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND - TRAIL VISUALIZATION (Chat Window)                                │
└─────────────────────────────────────────────────────────────────────────────┘

renderer/chat/modules/trail/TrailContainerManager.js::addExecutionToTrail()
  ⬇ Incoming:  MessageManager requests (execution phases)
  ⚙ Processing: Create trails via TrailDOMRenderer, track execution nodes
  ⬆ Outgoing:   DOM (TRAIL container with write→process→execute→output nodes)
```

---

## 🔄 COMPLETE USER MESSAGE FLOW

```
User types "say hey in html"
         ↓

┌─────────────────────────────────────────────────────────────────────────────┐
│ CHAT WINDOW                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘

MessageManager.js::sendMessage()
  → SessionManager.nextUserMessageId()
  → StreamHandler.js::_generateMessageId()
  → SendController.js::send()
  → Endpoint.js::guruConnection.send()

         ↓ WebSocket to Backend

┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKEND                                                                     │
└─────────────────────────────────────────────────────────────────────────────┘

ws/handlers.py::_handle_user_message()
  → core/runtime/engine.py::stream_chat()
  → core/integrations/providers/open_interpreter.py::execute()

         ↓ Streams back 4 artifact types

1. CODE (role=assistant, type=code, format=html)
2. CONSOLE (role=computer, type=console, format=output)  
3. HTML (role=computer, type=code, format=html)
4. IMAGE (role=computer, type=image, format=png)

         ↓ WebSocket to Frontend

┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND RECEIVES 4 ARTIFACTS                                               │
└─────────────────────────────────────────────────────────────────────────────┐

GuruConnection.js → ArtifactsStreamHandler.js
  ├─ Enriches with chatId
  ├─ Generates artifact IDs
  └─ Sends to 2 destinations:

    DESTINATION 1: ARTIFACTS WINDOW
    ├─ renderer/artifacts/renderer.js
    ├─ Accumulates: start → content chunks → end
    ├─ Displays in Code tab (HTML code)
    └─ Switches to Output tab (execution result)

    DESTINATION 2: CHAT WINDOW (TRAIL)
    ├─ MessageManager.js::_updateTrailWithArtifact()
    ├─ TrailContainerManager.js::addExecutionToTrail()
    └─ Creates visual nodes:
        ● write (HTML code written)
        ● process (validation/parsing)
        ● execute (code runs)
        ● output (result displayed)
```

---

## 🔑 KEY FILES & FUNCTIONS

### Backend
```
ws/handlers.py::relay_stream()
  → Streams artifacts to frontend
```

### Frontend Main Process
```
core/communication/GuruConnection.js::_handleMessage()
  → Receives WebSocket, parses JSON
  
application/main/ArtifactsStreamHandler.js::handleStream()
  → Enriches artifacts, generates IDs
```

### Frontend Chat Window
```
renderer/chat/controllers/ChatController.js::_handleArtifactStream()
  → Enriches with chatId
  
renderer/chat/modules/messaging/MessageManager.js::_updateTrailWithArtifact()
  → Creates TRAIL visualization
  
renderer/chat/modules/trail/TrailContainerManager.js::addExecutionToTrail()
  → Renders write→process→execute→output nodes
```

### Frontend Artifacts Window
```
renderer/artifacts/renderer.js::handleArtifactStream()
  → Accumulates streaming chunks
  
renderer/artifacts/renderer.js::_finalizeArtifact()
  → Persists to registry, displays in tabs
```

---

## 📋 STREAM PROTOCOL

```
START:  { id, role, type, format, start: true }
CHUNK:  { id, content: "partial data..." }
CHUNK:  { id, content: "more data..." }
END:    { id, end: true }
```

---

## ✅ FIXED ISSUES

1. ✅ `TrailStyleManager.inject()` - was calling `.injectStyles()`
2. ✅ Stream accumulation - now properly tracks start→chunks→end
3. ✅ Chat ID enrichment - artifacts linked to correct session
4. ✅ TRAIL container integration - visualizes execution pipeline
5. ✅ Tab switching - automatic based on artifact type

