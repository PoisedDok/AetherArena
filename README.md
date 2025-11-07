# 🌟 AetherArena

<div align="center">

![AetherArena](https://img.shields.io/badge/AetherArena-AI--Desktop-blue?style=for-the-badge&logo=electron&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Testing%20%26%20Debugging-orange?style=for-the-badge)

**AetherArena: Clean Architecture AI Desktop Application by AetherInc**

*Part of the AetherInc ecosystem • Python backend orchestrating 7+ AI services • Enterprise-grade security & privacy-first design*

[🚀 Quick Start](#-quick-start) • [📚 Documentation](#-documentation) • [🤝 Contributing](#-contributing)

</div>

---

## ⚠️ Current Status

> **🧪 TESTING & DEBUGGING PHASE**
>
> AetherArena is currently in active testing and debugging stage. We're working diligently to ensure stability, performance, and security before the final production release. The application is functional but may contain bugs or incomplete features.
>
> **🎯 Production Release**: Expected soon with full stability and feature completeness.



## 🚀 Overview

AetherArena is a flagship product in the AetherInc ecosystem, orchestrating a comprehensive suite of privacy-first AI services:

<div align="center">

| 🎨 **Neural Visualizer** | 💬 **Conversational AI** | ⚡ **Code Execution** |
|:---:|:---:|:---:|
| 3D visualization of AI processes | Streaming chat with multiple models | Real-time artifact generation |

| 🎤 **Voice Integration** | 📄 **Document Processing** | 🔍 **Web Search** |
|:---:|:---:|:---:|
| Speech-to-text & text-to-speech | Advanced OCR & analysis | Privacy-respecting aggregation |

| 📊 **Excel Automation** | 🔧 **Multi-Service** | 🛡️ **Security First** |
|:---:|:---:|:---:|
| Live spreadsheet manipulation | 7+ AI services orchestration | Enterprise-grade security |

</div>

## 🏗️ Architecture

### Project Structure
```
Aether Desktop/
├── aether-backend/          # Python FastAPI backend
│   ├── api/                 # REST API endpoints
│   ├── core/                # Business logic & integrations
│   ├── services/            # AI service orchestration
│   ├── data/                # Database & storage
│   ├── security/            # Authentication & crypto
│   └── monitoring/          # Health checks & metrics
│
├── aether-frontend/         # Electron desktop application
│   ├── src/
│   │   ├── main/           # Electron main process
│   │   ├── preload/        # Security boundary scripts
│   │   ├── renderer/       # UI renderer processes
│   │   ├── core/           # Framework-agnostic utilities
│   │   ├── domain/         # Business logic
│   │   └── infrastructure/ # External service integrations
│   └── build/              # Distribution artifacts
│
└── docs/                   # Architecture documentation
```

### Backend Services
The backend orchestrates AetherInc's comprehensive AI service ecosystem:
- **🤖 GURU AI Paralegal**: Legal-focused AI assistant with document analysis capabilities
- **🔍 Privacy-First Search**: Multiple search engines with privacy protection
- **📄 Document Intelligence**: Advanced OCR and document processing
- **📊 Excel Automation**: Live spreadsheet manipulation
- **👁️ Vision Processing**: UI parsing and visual analysis
- **🔒 Secure Orchestration**: Privacy-preserving AI service integration
- **🎤 Real-time TTS**: Text-to-speech synthesis capabilities

## 🛠️ Technology Stack

### Backend
- **Python 3.9+**: Core runtime
- **FastAPI**: REST API framework
- **WebSocket**: Real-time communication
- **PostgreSQL**: Primary database
- **Redis**: Caching and session storage
- **Docker**: Service containerization

### Frontend
- **Electron 25.1.1**: Desktop framework
- **Node.js ≥18.0.0**: Runtime environment
- **Three.js**: 3D visualization
- **DOMPurify**: Content sanitization
- **Marked**: Markdown rendering
- **Ace Editor**: Code editing interface
- **Zod**: Schema validation

### Security
- **Context Isolation**: Electron security boundary
- **Content Security Policy**: XSS prevention
- **IPC Validation**: Secure inter-process communication
- **Input Sanitization**: All user input filtered
- **Permission Whitelisting**: Minimal Chromium permissions

## 🚀 Quick Start

### Prerequisites
- Python 3.9+
- Node.js 18+
- PostgreSQL
- Redis (optional)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd AetherArena
   ```

2. **Setup Backend**
   ```bash
   cd aether-backend
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   pip install -r requirements.txt
   cp config/environments/development.yaml config/environments/local.yaml
   # Edit local.yaml with your configuration
   python scripts/setup_database.sh
   ```

3. **Setup Frontend**
   ```bash
   cd ../aether-frontend
   npm install
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start Development Environment**
   ```bash
   # Terminal 1: Start backend
   cd aether-backend
   python main.py

   # Terminal 2: Start frontend
   cd aether-frontend
   npm run dev
   ```

## ⚙️ Configuration

### Backend Configuration
Key settings in `aether-backend/config/environments/`:
```yaml
database:
  url: postgresql://user:pass@localhost:5432/aether
  pool_size: 10

integrations:
  perplexica_enabled: true
  perplexica_url: http://localhost:3000
  docling_enabled: true
  docling_url: http://localhost:8000

security:
  jwt_secret: "your-secret-key"
  cors_origins: ["http://localhost:3000"]
```

### Frontend Configuration
Environment variables in `aether-frontend/.env`:
```bash
# Backend
GURU_API_URL=http://localhost:8765
GURU_SPAWN_BACKEND=true

# UI
WIDGET_SIZE=180
NORMAL_WIDTH=800
NORMAL_HEIGHT=600

# Features
ENABLE_VOICE_INPUT=true
ENABLE_TTS=true
```

## 🔧 Development

### Backend Development
```bash
cd aether-backend

# Run tests
pytest

# Run with auto-reload
uvicorn app:app --reload --host 0.0.0.0 --port 8765

# Check API documentation
open http://localhost:8765/docs
```

### Frontend Development
```bash
cd aether-frontend

# Development mode with hot reload
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Testing Strategy
- **Unit Tests**: Individual component testing
- **Integration Tests**: Service interaction testing
- **E2E Tests**: Full user workflow testing
- **Security Tests**: Penetration testing and vulnerability scanning

## 📁 Key Directories

### Backend Structure
- `api/v1/endpoints/`: REST API endpoints
- `core/integrations/`: AI service integrations
- `core/runtime/`: Execution engine and orchestration
- `data/database/`: Database models and migrations
- `security/`: Authentication and authorization
- `monitoring/`: Health checks and observability

### Frontend Structure
- `src/main/`: Electron main process
- `src/preload/`: Security boundary scripts
- `src/renderer/`: UI renderer processes
- `src/core/`: Framework utilities
- `src/domain/`: Business logic modules
- `src/infrastructure/`: External integrations

## 🔒 Security Features

- **Electron Hardening**: Context isolation, CSP, permission whitelisting
- **Input Validation**: Comprehensive sanitization of all user input
- **IPC Security**: Validated inter-process communication channels
- **API Security**: JWT authentication, rate limiting, CORS
- **Data Protection**: Encrypted storage, secure key management

## 📊 Performance Targets

- **Cold Start**: < 2 seconds
- **Memory Usage**: < 400MB steady-state
- **IPC Latency**: < 10ms
- **Window Creation**: < 500ms
- **API Response**: < 100ms average

## 🤝 Contributing

### Development Workflow
1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes following clean architecture principles
4. Add tests for new functionality
5. Ensure all tests pass: `npm test && pytest`
6. Submit a pull request

### Code Style
- **Python**: PEP 8 with Black formatting
- **JavaScript**: ESLint with Airbnb config
- **Documentation**: JSDoc for APIs, docstrings for Python
- **Commits**: Conventional commits format

### Architecture Guidelines
- **Clean Architecture**: Strict separation of concerns
- **Dependency Injection**: Service management through DI container
- **Event-Driven**: Loose coupling through event bus
- **Repository Pattern**: Data access abstraction
- **Security First**: All new features must pass security review

## 📚 Documentation

- `ARCHITECTURE_DATA_PIPELINE.md`: Data flow and pipeline documentation
- `FULL_STACK_TRACER_GUIDE.md`: Debugging and tracing guide
- `aether-backend/docs/`: Backend-specific documentation
- `aether-frontend/docs/`: Frontend-specific documentation

## 🚦 Status

**Current Phase**: Frontend Phase 2 of 14 (Main Process Kernel) ✅ Complete
**Next Phase**: Phase 3 (Preload Layer) 🚧 In Progress

### Migration Status
This is a complete rebuild following a 14-phase migration plan from legacy codebase to clean architecture.

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

Individual AI services and third-party components maintain their respective licenses. The main AetherArena application code is MIT licensed.

## 🔗 Links

- **Frontend README**: `aether-frontend/README.md`
- **Backend Services**: `aether-backend/services/README.md`
- **API Documentation**: Available at `/docs` when backend is running
- **Issue Tracker**: GitHub Issues
- **Architecture Docs**: `docs/` directory

---

## 🏢 About AetherInc

AetherArena is developed by **AetherInc Limited**, a Scotland-registered company founded by Krish Dokania. AetherInc specializes in privacy-first AI solutions, creating revolutionary AI companions that solve real-world tasks through natural conversation.

**Company Details:**
- **Founded**: By Krish Dokania
- **Registered**: Scotland, UK (Company Registration: SCXXXXXX)
- **Mission**: Transform how people interact with AI through privacy-first solutions
- **Website**: [aetherinc.xyz](https://aetherinc.xyz)
- **Social**: [Twitter](https://twitter.com/aetherinc) • [LinkedIn](https://linkedin.com/company/aetherinc) • [GitHub](https://github.com/aetherinc)

**Product Portfolio:**
- **🤖 GURU AI Paralegal**: Privacy-first legal AI assistant for document review, drafting, and case analysis
- **🖥️ AetherArena**: Clean architecture AI desktop application
- **⚖️ Legal Pilot**: Specialized AI solutions for law firms
- **📊 ROI Calculator**: Business value assessment tool
- **🔧 AI Consulting**: Enterprise AI implementation services

**Business Model:**
- **Pricing**: Subscription-based with tiered offerings
- **Target Markets**: Law firms, enterprises, AI enthusiasts
- **Development**: Documentation and advanced features in development
- **Support**: Direct consultation and pilot programs available

---

<div align="center">

## 🌟 AetherArena - Clean Architecture AI Desktop Application

**Built with ❤️ by AetherInc using Python, Electron, and cutting-edge AI technologies**

---

*Made with passion for the AI community • Currently in testing phase • Production release coming soon*

[⬆️ Back to Top](#-aetherarena)

</div>
