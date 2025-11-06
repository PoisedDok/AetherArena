# Settings System - Complete Architecture

## Overview
Comprehensive settings management system with full backend-frontend integration, supporting 8 configuration sections across frontend UI with immediate application of changes.

## Backend Architecture

### API Endpoints
- `GET /v1/settings` - Retrieve all application settings
- `PATCH /v1/settings` - Update settings (partial updates supported)
- `GET /v1/services/status` - Get health status of all services/integrations

### Settings Sections (Pydantic Models)

#### 1. LLM Settings
```python
provider: str = "openai-compatible"
api_base: HttpUrl = "http://localhost:1234/v1"
model: str = "qwen/qwen3-4b-2507"
supports_vision: bool = False
context_window: int = 100000
max_tokens: int = 4096
temperature: float = 0.7
```

#### 2. Interpreter Settings
```python
auto_run: bool = False
loop: bool = False
safe_mode: str = "off"
system_message: str = ""
profile: str = "GURU.py"
offline: bool = True
disable_telemetry: bool = True
```

#### 3. Security Settings
```python
bind_host: str = "127.0.0.1"
bind_port: int = 8765
allowed_origins: List[str]
cors_allow_credentials: bool = True
auth_enabled: bool = False
rate_limit_enabled: bool = False
```

#### 4. Database Settings
```python
url: str = "postgresql://..."
pool_size: int = 10
max_overflow: int = 20
pool_timeout: int = 30
echo_sql: bool = False
```

#### 5. Monitoring Settings
```python
log_level: str = "INFO"
log_format: str = "json"
metrics_enabled: bool = True
tracing_enabled: bool = True
health_check_interval: int = 30
```

#### 6. Memory Settings
```python
enabled: bool = True
type: str = "sqlite"
path: str = "./data/memory.db"
embedder: str = "local-minilm"
top_k: int = 5
```

#### 7. Storage Settings
```python
base_path: str = "data/storage"
max_upload_size_mb: int = 100
allowed_extensions: List[str]
```

#### 8. Integration Settings
```python
perplexica_url: str = "http://localhost:3000"
perplexica_enabled: bool = True
searxng_url: str = "http://127.0.0.1:4000"
searxng_enabled: bool = True
docling_url: str = "http://127.0.0.1:8000"
docling_enabled: bool = True
xlwings_url: str = "http://127.0.0.1:8001"
xlwings_enabled: bool = True
lm_studio_url: str = "http://localhost:1234/v1"
lm_studio_enabled: bool = True
mcp_enabled: bool = True
mcp_auto_start: bool = True
mcp_health_check_interval: int = 30
```

## Frontend Architecture

### Settings Modal Structure

#### Sidebar Navigation (8 Tabs)
1. **Assistant** - LLM provider, model selection, profiles
2. **Services** - Real-time service health monitoring
3. **Integrations** - Enable/disable integrations, configure URLs
4. **Advanced** - LLM temperature/tokens/context, interpreter system message
5. **Database** - Connection pool settings, SQL echo
6. **Memory** - RAG/vector database configuration
7. **Monitoring** - Logging, metrics, tracing
8. **Storage** - Upload limits and file extensions

### SettingsManager Class

#### Core Methods

##### Data Loading
- `loadSettings()` - Fetch all settings from backend
- `loadServicesStatus()` - Fetch service health information
- `populateForm(settings)` - Populate all form fields

##### Form Population (Private)
- `_populateLLMSettings(llm)`
- `_populateInterpreterSettings(interpreter)`
- `_populateSecuritySettings(security)`
- `_populateIntegrationSettings(integrations)`
- `_populateDatabaseSettings(database)`
- `_populateMonitoringSettings(monitoring)`
- `_populateMemorySettings(memory)`
- `_populateStorageSettings(storage)`
- `_populateAdvancedSettings(llm, interpreter)`

##### Data Collection
- `collectSettings()` - Gather all form data
- `_collectLLMSettings()`
- `_collectInterpreterSettings()`
- `_collectSecuritySettings()`
- `_collectIntegrationSettings()`
- `_collectDatabaseSettings()`
- `_collectMonitoringSettings()`
- `_collectMemorySettings()`
- `_collectStorageSettings()`
- `_collectAdvancedLLMSettings()`
- `_collectAdvancedInterpreterSettings()`

##### Settings Management
- `saveSettings()` - Send updates to backend, apply immediately
- `_applySettings(settings)` - Trigger UI refresh and model indicator update
- `_validateSettings(settings)` - Validate before saving

### Service Status Display

#### Service Health Check
- Backend endpoint checks HTTP connectivity to each service
- Supports multiple health check strategies (primary + fallback)
- Returns: status (online/offline/degraded), response_time_ms, error details

#### Frontend Display
- Grid layout with service cards
- Color-coded status pills (green=online, yellow=degraded, red=offline)
- Response times and port information
- Real-time updates when switching to Services tab

## Data Flow

### Settings Load Flow
```
User opens settings modal
  → SettingsManager.loadSettings()
  → Endpoint.getSettings() [GET /v1/settings]
  → Backend returns all 8 settings sections
  → SettingsManager.populateForm(settings)
  → All 8 tabs populated with current values
```

### Settings Save Flow
```
User modifies settings and clicks Save
  → SettingsManager.collectSettings()
  → Gathers data from all visible/modified sections
  → SettingsManager._validateSettings()
  → SettingsManager.saveSettings()
  → Endpoint.updateSettings() [PATCH /v1/settings]
  → Backend validates and persists changes
  → SettingsManager._applySettings()
  → Dispatch 'settings-updated' event
  → MainApp.updateModelIndicator() refreshes UI
  → Success notification shown
```

### Service Status Flow
```
User switches to Services tab
  → MainApp.switchSettingsTab('connections')
  → SettingsManager.loadServicesStatus()
  → Endpoint.getServicesStatus() [GET /v1/services/status]
  → Backend checks health of all enabled services
  → Returns status array with health details
  → SettingsManager displays service cards with status
```

## UI/UX Features

### Glassmorphism Design
- Transparent backgrounds with blur effects
- Subtle borders and shadows
- Accent gradients (cyan/green)
- Dark theme optimized

### Responsive Layout
- 90vh height for maximum workspace
- Compact 180px sidebar
- Flexible main content area
- Scrollable sections

### Immediate Feedback
- Settings apply instantly on save (no restart required)
- Service health checks with response times
- Form validation before submission
- Success/error notifications

## File Structure

### Backend
```
aether-backend/
  api/v1/
    schemas/settings.py          # Pydantic models (expanded)
    endpoints/settings.py         # Settings CRUD endpoints
    endpoints/services.py         # Service health checks (NEW)
    router.py                     # Route aggregation
  config/settings.py              # Settings loader
```

### Frontend
```
aether-frontend/src/renderer/main/
  index.html                      # Modal HTML with 8 tabs
  styles/main.css                 # Glassmorphism styling
  modules/settings/
    SettingsManager.js            # Complete settings manager
  main-renderer.js                # Tab switching logic
```

## Configuration Files
- `aether-backend/config/models_config.toml` - Model configurations
- `aether-backend/config/integrations_registry.yaml` - Integration metadata

## Security Considerations
- Settings validated on both frontend and backend
- URL format validation
- Numeric range validation
- CORS origin whitelist
- Optional authentication support

## Performance
- Partial updates via PATCH (only modified sections sent)
- Service health checks with 2s timeout
- Async operations with proper error handling
- Cached form elements for fast access

## Future Enhancements
- Settings export/import
- Settings versioning/rollback
- Real-time settings sync across windows
- Settings profiles/presets
- Advanced validation rules

