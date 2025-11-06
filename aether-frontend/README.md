# Aether Desktop - Clean Architecture Rebuild

Production-ready Electron desktop application with clean architecture, complete modularization, and security hardening.

## Architecture Overview

Three-window Electron application:
- **Main Window**: Neural visualizer, widget mode, voice input
- **Chat Window**: Conversational AI interface with streaming
- **Artifacts Window**: Code execution and output rendering

### Technology Stack

- **Electron** 25.1.1 - Desktop framework
- **Node.js** ≥18.0.0 - Runtime
- **WebSocket** - Real-time communication
- **Three.js** - 3D visualization
- **DOMPurify** - Content sanitization
- **Marked** - Markdown rendering
- **Ace Editor** - Code editing
- **Zod** - Schema validation

### Backend Integration

Integrates with Python backend services:
- **Aether Hub**: Unified backend orchestrator
- **Perplexica**: Web search aggregator
- **SearxNG**: Privacy-respecting search
- **Docling**: Document processing
- **XLWings**: Excel integration
- **LM Studio**: Local LLM inference

---

## Project Structure

```
aether-frontend/
├── src/
│   ├── main/                    # Main process (Electron)
│   │   ├── index.js             # Entry point
│   │   ├── windows/             # Window management
│   │   ├── services/            # IPC, shortcuts, service launcher
│   │   ├── security/            # External links, permissions
│   │   └── utils/               # Display utilities
│   │
│   ├── preload/                 # Preload scripts (security boundary)
│   │   ├── main-preload.js
│   │   ├── chat-preload.js
│   │   ├── artifacts-preload.js
│   │   ├── common/              # Shared preload utilities
│   │   └── ipc/                 # IPC security layer
│   │
│   ├── renderer/                # Renderer processes (UI)
│   │   ├── main/                # Main window
│   │   ├── chat/                # Chat window
│   │   ├── artifacts/           # Artifacts window
│   │   └── shared/              # Shared UI components
│   │
│   ├── core/                    # Core framework (process-agnostic)
│   │   ├── config/              # Unified configuration
│   │   ├── di/                  # Dependency injection
│   │   ├── events/              # Event bus
│   │   ├── communication/       # WebSocket, HTTP client
│   │   ├── security/            # Security layer
│   │   ├── storage/             # Storage abstraction
│   │   └── utils/               # Logger, error handling
│   │
│   ├── domain/                  # Business logic
│   │   ├── chat/                # Chat domain
│   │   ├── artifacts/           # Artifacts domain
│   │   ├── audio/               # Audio domain
│   │   └── settings/            # Settings domain
│   │
│   ├── infrastructure/          # Infrastructure layer
│   │   ├── api/                 # API clients
│   │   ├── ipc/                 # IPC infrastructure
│   │   ├── persistence/         # Data persistence
│   │   └── monitoring/          # Observability
│   │
│   ├── application/             # Application services
│   │   ├── main/                # Main orchestrators
│   │   ├── chat/                # Chat orchestrators
│   │   └── artifacts/           # Artifacts orchestrators
│   │
│   └── types/                   # TypeScript definitions
│
├── tests/                       # Test files
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── fixtures/
│   └── helpers/
│
├── assets/                      # Static assets
├── resources/                   # Build resources
├── build/                       # Build output
└── dist/                        # Distribution packages
```

---

## Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp env.example .env

# Edit configuration
nano .env
```

---

## Development

```bash
# Start in development mode
npm run dev

# Start with mock backend
DEBUG_MODE=true MOCK_BACKEND=true npm run dev
```

### Development Tools

- **DevTools**: Automatically opened in development
- **Hot Reload**: Restart app to see changes
- **Logs**: `~/Library/Application Support/aether-desktop/logs/`
- **Data**: `~/Library/Application Support/aether-desktop/data/`

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+D` or `F11` | Toggle widget mode |
| `Escape` | Exit widget mode |
| `Alt+C` | Toggle chat window |
| `Alt+A` | Toggle artifacts window |

---

## Configuration

Configuration precedence (highest to lowest):
1. Environment variables (`.env`)
2. Default values (`src/core/config/defaults.js`)

### Key Configuration Options

```bash
# Backend
GURU_API_URL=http://localhost:8765
GURU_SPAWN_BACKEND=true

# UI
WIDGET_SIZE=180
NORMAL_WIDTH=800
NORMAL_HEIGHT=600

# Logging
LOG_LEVEL=info              # error | warn | info | debug | trace
LOG_MAX_FILE_SIZE=10485760  # 10MB
LOG_MAX_FILES=5

# Security
SANITIZER_PROFILE=strict    # strict | moderate | permissive
MAX_MESSAGE_SIZE=10000
MAX_MESSAGES_PER_MINUTE=60

# Features
ENABLE_VOICE_INPUT=true
ENABLE_TTS=true
FEATURE_ARTIFACTS_STREAM=true
```

---

## Security

### Electron Security Checklist

✅ **contextIsolation**: Enabled  
✅ **nodeIntegration**: Disabled  
✅ **webSecurity**: Enabled  
✅ **Content Security Policy**: Enforced  
✅ **External Navigation**: Blocked  
✅ **Permission Whitelisting**: Implemented  
✅ **IPC Channel Validation**: Implemented  
✅ **Content Sanitization**: DOMPurify  

### Security Features

- **External Link Handler**: Opens external URLs in system browser
- **Permission Handler**: Whitelists only necessary Chromium permissions
- **IPC Router**: Validates message sources and channels
- **Content Sanitization**: All user-generated content sanitized
- **Rate Limiting**: Prevents IPC flooding

---

## Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

---

## Building

```bash
# Build renderer bundles
npm run build:renderer

# Build for all platforms
npm run build

# Build for specific platform
npm run build:mac
npm run build:win
npm run build:linux

# Pack without building installer (fast)
npm run pack
```

### Build Output

```
dist/
├── Aether-Desktop-2.0.0.dmg          # macOS installer
├── Aether-Desktop-2.0.0-arm64.dmg    # macOS ARM installer
├── Aether-Desktop-Setup-2.0.0.exe    # Windows installer
├── Aether-Desktop-2.0.0.AppImage     # Linux AppImage
└── aether-desktop_2.0.0_amd64.deb    # Debian package
```

---

## Logging

### Log Locations

- **macOS**: `~/Library/Application Support/aether-desktop/logs/`
- **Windows**: `%APPDATA%\aether-desktop\logs\`
- **Linux**: `~/.config/aether-desktop/logs/`

### Log Format

```
[2025-01-15T10:30:45.123Z] [main:12345] [INFO] Message {context: "value"}
```

### Log Rotation

- Max file size: 10MB (default)
- Max rotated logs: 5 (default)
- Format: `aether.log`, `aether.1.log`, ..., `aether.5.log`

---

## Architecture Patterns

### Clean Architecture Layers

1. **Domain Layer**: Business logic, entities, use cases
2. **Application Layer**: Orchestration, workflows
3. **Infrastructure Layer**: External services, APIs, persistence
4. **Presentation Layer**: UI, renderers, controllers

### Design Patterns

- **Dependency Injection**: DI container for service management
- **Event Bus**: Pub/sub for loose coupling
- **Repository Pattern**: Data access abstraction
- **Factory Pattern**: Object creation
- **Singleton Pattern**: Shared services (logger, config)
- **Observer Pattern**: Event-driven communication
- **Strategy Pattern**: Pluggable algorithms (sanitizers, renderers)

### Security Patterns

- **Preload Security Boundary**: contextBridge API only
- **Channel Whitelisting**: No dynamic IPC registration
- **Source Validation**: event.sender checks
- **Content Sanitization**: All user input sanitized
- **Permission Whitelisting**: Only necessary permissions

---

## Migration from Legacy Frontend

This is a **clean rebuild** of the Aether Desktop frontend following a strict 14-phase migration plan:

- ✅ **Phase 1**: Core config & security foundation
- ✅ **Phase 2**: Main-process kernel
- 🚧 **Phase 3**: Preload layer
- 🔲 **Phase 4**: Renderer bootstrap
- 🔲 **Phase 5**: Domain extraction
- 🔲 **Phase 6**: Core communication
- 🔲 **Phase 7**: Infrastructure layer
- 🔲 **Phase 8**: Application orchestrators
- 🔲 **Phase 9**: UI/UX polish
- 🔲 **Phase 10**: Performance hardening
- 🔲 **Phase 11**: Security & compliance
- 🔲 **Phase 12**: Testing matrix
- 🔲 **Phase 13**: Packaging & CI/CD
- 🔲 **Phase 14**: Legacy decommission

**Current Status**: Phase 2 complete, Phase 3 in progress

---

## Troubleshooting

### App Won't Start

1. Check backend is running: `curl http://localhost:8765/health`
2. Check logs: `tail -f ~/Library/Application\ Support/aether-desktop/logs/aether.log`
3. Try dev mode: `npm run dev`
4. Clear cache: `rm -rf ~/Library/Application\ Support/aether-desktop/`

### Windows Won't Load

1. Check DevTools console (Ctrl+Shift+I)
2. Check preload scripts loaded
3. Verify IPC bridge: `window.aether` should exist
4. Check for CSP violations

### IPC Communication Fails

1. Verify channel is registered in `IpcRouter.js`
2. Check source validation
3. Check payload size limits
3. Enable IPC debug logging: `DEBUG_MODE=true npm run dev`

### Backend Connection Issues

1. Verify backend URL: `echo $GURU_API_URL`
2. Check backend health: `curl http://localhost:8765/health`
3. Disable spawning: `GURU_SPAWN_BACKEND=false npm run dev`
4. Check firewall/antivirus

---

## Performance Targets

- **Cold Start**: < 2s
- **Memory Usage**: < 400MB steady-state
- **IPC Latency**: < 10ms
- **Window Creation**: < 500ms
- **Log Write**: Non-blocking (batched)

---

## Contributing

### Code Style

- **JavaScript**: ES6+ with strict mode
- **Indentation**: 2 spaces
- **Line Length**: 100 characters
- **Comments**: JSDoc for public APIs
- **Naming**: camelCase for variables, PascalCase for classes

### Commit Guidelines

```
type(scope): subject

body

footer
```

**Types**: feat, fix, docs, style, refactor, perf, test, chore

---

## License

ISC

---

## Links

- **Documentation**: `docs/`
- **Issue Tracker**: GitHub Issues
- **Backend Repository**: `../aether-backend/`
- **Build Scripts**: `scripts/`

---

**Current Phase**: 2 of 14 (Main Process Kernel)  
**Status**: ✅ Complete  
**Next**: Phase 3 (Preload Layer)

