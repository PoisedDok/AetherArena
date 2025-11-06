# Aether Backend Services

This directory contains all backend services that are orchestrated by the Aether Backend.

**Design Philosophy:** Each service is self-contained and can run independently. The aether-backend orchestrates these services through its API layer, providing a unified interface to the frontend.

---

## Service Architecture

```
services/
├── open-interpreter/      # Open Interpreter - Code execution and AI orchestration
├── perplexica/           # Perplexica - AI-powered web search
├── docling/              # Docling - Advanced document parsing
├── xlwings/              # XLWings - Excel automation server
├── omniparser/           # OmniParser - Vision-based UI parsing
├── searxng/              # SearxNG - Privacy-respecting metasearch
├── realtime-tts/         # RealtimeTTS - Real-time text-to-speech
├── rhasspy/              # Rhasspy - Voice assistant framework
└── chandra/              # Chandra - Vision model inference
```

---

## Service Descriptions

### 🤖 Open Interpreter
**Path:** `services/open-interpreter/`  
**Purpose:** Core AI orchestration engine - executes code, manages tools, coordinates workflows  
**Entry Point:** Python package import  
**Used By:** `core/runtime/interpreter.py`

### 🔍 Perplexica
**Path:** `services/perplexica/`  
**Purpose:** AI-powered web search with multiple engines and focus modes  
**Entry Point:** Node.js server on port 3000  
**API Wrapper:** `core/integrations/providers/perplexica/`

### 📄 Docling
**Path:** `services/docling/`  
**Purpose:** Advanced document parsing with OCR, table extraction, and structure preservation  
**Entry Point:** Python API server on port 8000  
**API Wrapper:** `core/integrations/providers/docling/`

### 📊 XLWings
**Path:** `services/xlwings/`  
**Purpose:** Live Excel automation - create, manipulate, save workbooks programmatically  
**Entry Point:** Python API server on port 8001  
**API Wrapper:** `core/integrations/libraries/xlwings/`

### 👁️ OmniParser
**Path:** `services/omniparser/`  
**Purpose:** Vision-based UI parsing - screen analysis, element detection, OCR  
**Entry Point:** Python package with Gradio demo  
**API Wrapper:** `core/integrations/libraries/omni/`

### 🔎 SearxNG
**Path:** `services/searxng/`  
**Purpose:** Privacy-respecting metasearch engine aggregating results from multiple sources  
**Entry Point:** Python server on port 4000  
**Used By:** Perplexica and direct API calls

### 🗣️ RealtimeTTS
**Path:** `services/realtime-tts/`  
**Purpose:** Real-time text-to-speech synthesis  
**Entry Point:** Python package  
**Status:** Optional service

### 🎤 Rhasspy
**Path:** `services/rhasspy/`  
**Purpose:** Voice assistant framework with offline capability  
**Entry Point:** Python service  
**Status:** Optional service

### 👁️ Chandra
**Path:** `services/chandra/`  
**Purpose:** Specialized vision model for image understanding  
**Entry Point:** Python package  
**API Wrapper:** Used by runtime for vision tasks

---

## Service Lifecycle

### Automatic Services (Started by aether-backend)
- **Open Interpreter** - Loaded on runtime engine startup
- **MCP Servers** - Auto-started if enabled in config

### External Services (User-managed)
- **Perplexica** - Start with `node perplexica-launcher.js` or Docker
- **SearxNG** - Start with `python start_searxng.py`
- **Docling** - Start with `python docling_api_server.py`
- **XLWings** - Start with `python xlwings_api_server.py`

### On-Demand Services
- **OmniParser** - Loaded when vision tasks are requested
- **Chandra** - Loaded when vision inference is needed
- **RealtimeTTS** - Loaded when TTS is requested
- **Rhasspy** - Loaded when voice assistant is requested

---

## Integration Points

Services are integrated through:

1. **Direct Imports** - Open Interpreter, OmniParser, Chandra
2. **HTTP APIs** - Perplexica, Docling, XLWings, SearxNG  
3. **MCP Protocol** - Filesystem, memory, custom servers
4. **Computer API** - OI's unified tool interface

### Integration Wrappers

Located in `core/integrations/`:
- `providers/perplexica/` - Perplexica API client
- `providers/docling/` - Docling API client
- `libraries/xlwings/` - XLWings integration
- `libraries/omni/` - OmniParser integration
- `libraries/notebook/` - Jupyter notebook support

---

## Configuration

Service configurations are managed in:
- `config/settings.py` - Main settings schema
- `config/models.toml` - Model and service URLs
- `config/integrations_registry.yaml` - Integration metadata

### Example Configuration

```python
# config/settings.py
class IntegrationSettings(BaseModel):
    perplexica_url: str = "http://localhost:3000"
    perplexica_enabled: bool = True
    
    searxng_url: str = "http://127.0.0.1:4000"
    searxng_enabled: bool = True
    
    docling_url: str = "http://127.0.0.1:8000"
    docling_enabled: bool = True
```

---

## Service Dependencies

### Python Services
- Open Interpreter: See `services/open-interpreter/requirements.txt`
- Docling: See `services/docling/requirements.txt`
- XLWings: See `services/xlwings/requirements.txt`
- OmniParser: See `services/omniparser/requirements.txt`

### Node.js Services
- Perplexica: See `services/perplexica/package.json`

### System Services
- SearxNG: Python with Redis (optional)
- Rhasspy: Python with audio libraries

---

## Development

### Adding a New Service

1. **Place service in `services/` directory**
2. **Create integration wrapper in `core/integrations/`**
3. **Add service configuration to `config/settings.py`**
4. **Update `core/runtime/engine.py` if auto-start needed**
5. **Add API endpoints in `api/v1/endpoints/` if exposing to frontend**
6. **Update this README**

### Service Testing

Each service should have its own test suite:
- Unit tests: `services/{service}/tests/`
- Integration tests: `tests/integration/test_{service}.py`
- E2E tests: `tests/e2e/test_{service}_flow.py`

---

## Service Status

| Service | Status | Auto-Start | Required |
|---------|--------|------------|----------|
| Open Interpreter | ✅ Active | Yes | Yes |
| Perplexica | ✅ Active | No | No |
| Docling | ✅ Active | No | No |
| XLWings | ✅ Active | No | No |
| OmniParser | ✅ Active | On-demand | No |
| SearxNG | ✅ Active | No | No |
| Chandra | ✅ Active | On-demand | No |
| RealtimeTTS | ⚠️ Optional | On-demand | No |
| Rhasspy | ⚠️ Optional | No | No |

---

## Architecture Benefits

### Modularity
- Each service is independent and replaceable
- Services can be updated without affecting others
- Easy to add/remove services

### Scalability
- Services can run on different machines
- Load can be distributed across servers
- Horizontal scaling possible per service

### Maintainability
- Clear separation of concerns
- Independent versioning per service
- Easier debugging and testing

### Frontend Isolation
- Frontend only talks to aether-backend
- Service changes don't affect frontend
- Unified API contract

---

## Troubleshooting

### Service Won't Start
1. Check service logs in respective directory
2. Verify dependencies are installed
3. Check port availability
4. Verify configuration in `config/settings.py`

### Integration Issues
1. Check integration wrapper in `core/integrations/`
2. Verify service URL in config
3. Test service directly (bypass integration)
4. Check aether-backend logs

### Performance Issues
1. Monitor service resource usage
2. Check network latency for HTTP services
3. Review service logs for bottlenecks
4. Consider caching or load balancing

---

## License

Each service maintains its own license. See individual service directories for license information.

---

## Contributing

When contributing service-related changes:
1. Test service independently first
2. Test integration with aether-backend
3. Update this README if adding/changing services
4. Document any new configuration options
5. Add tests for integration points

