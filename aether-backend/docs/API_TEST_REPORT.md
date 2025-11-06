# Aether Backend API Test Report

**Test Date:** 2025-11-04 21:02:29
**Base URL:** http://127.0.0.1:5002
**Total Tests:** 40
**Passed:** 40
**Failed:** 0
**Errors:** 0
**Pass Rate:** 100.0%

## Detailed Results

### 

| Status | Method | Endpoint | Status Code | Response Time | Description |
|--------|--------|----------|-------------|---------------|-------------|
| ✅ | GET | / | 200 | 2ms | Root endpoint |

### V1

| Status | Method | Endpoint | Status Code | Response Time | Description |
|--------|--------|----------|-------------|---------------|-------------|
| ✅ | GET | /v1/health | 200 | 1ms | Simple health check |
| ✅ | GET | /v1/health/detailed | 200 | 108ms | Detailed health check |
| ✅ | GET | /v1/health/ready | 200 | 2ms | Readiness probe |
| ✅ | GET | /v1/health/live | 200 | 2ms | Liveness probe |
| ✅ | GET | /v1/api/status | 200 | 2ms | Legacy status endpoint |
| ✅ | GET | /v1/health/component/system | 200 | 105ms | System component health |
| ✅ | GET | /v1/health/component/runtime | 200 | 1ms | Runtime component health |
| ✅ | GET | /v1/health/component/database | 200 | 2ms | Database component health |
| ✅ | GET | /v1/health/component/nonexistent | 404 | 3ms | Non-existent component |
| ✅ | GET | /v1/settings | 200 | 4ms | Get application settings |
| ✅ | POST | /v1/settings | 200 | 4ms | Update settings (POST) |
| ✅ | PUT | /v1/settings | 200 | 3ms | Update settings (PUT) |
| ✅ | PATCH | /v1/settings | 200 | 3ms | Update settings (PATCH) |
| ✅ | POST | /v1/settings/reload | 200 | 11ms | Reload settings |
| ✅ | GET | /v1/models | 200 | 15ms | List models |
| ✅ | GET | /v1/models/active | 200 | 2ms | Get active model |
| ✅ | GET | /v1/models/capabilities | 200 | 4ms | Model capabilities |
| ✅ | GET | /v1/profiles | 200 | 2ms | List profiles |
| ✅ | GET | /v1/profiles/active | 200 | 1ms | Get active profile |
| ✅ | POST | /v1/profiles/switch | 200 | 2ms | Switch profile |
| ✅ | GET | /v1/profiles/GURU.yaml | 404 | 2ms | Get profile details |
| ✅ | GET | /v1/skills | 200 | 3ms | List skills |
| ✅ | POST | /v1/skills/new | 200 | 3ms | Create new skill |
| ✅ | POST | /v1/skills/import | 200 | 4ms | Import skill |
| ✅ | GET | /v1/launch_terminal | 200 | 22ms | Launch terminal |
| ✅ | POST | /v1/files/upload | 422 | 2ms | Upload file (no file) |
| ✅ | GET | /v1/files | 200 | 2ms | List files |
| ✅ | POST | /v1/chat | 200 | 1868ms | Send chat message |
| ✅ | GET | /v1/chat/history/default | 200 | 1ms | Get chat history |
| ✅ | GET | /v1/api/storage | 200 | 2ms | List storage items |
| ✅ | GET | /v1/api/storage/stats | 200 | 2ms | Get storage stats |
| ✅ | GET | /v1/api/health | 200 | 1ms | Storage health check |
| ✅ | POST | /v1/api/chats | 501 | 3ms | Create chat |
| ✅ | GET | /v1/api/chats/00000000-0000-0000-0000-000000000000 | 501 | 3ms | Get chat (stub) |
| ✅ | PUT | /v1/api/chats/00000000-0000-0000-0000-000000000000 | 501 | 3ms | Update chat (stub) |
| ✅ | DELETE | /v1/api/chats/00000000-0000-0000-0000-000000000000 | 501 | 2ms | Delete chat (stub) |
| ✅ | GET | /v1/api/mcp/servers | 200 | 7ms | List MCP servers |
| ✅ | GET | /v1/api/mcp/health | 200 | 3ms | MCP system health |
| ✅ | POST | /v1/api/mcp/servers | 201 | 6ms | Register MCP server |

