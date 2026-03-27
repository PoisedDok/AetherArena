# Perplexica Docker Usage

⚠️ **DO NOT USE `docker-compose` IN THIS DIRECTORY** ⚠️

## Centralized Docker Compose Location

All Aether services (including Perplexica) are managed through the **centralized docker-compose**:

```bash
# Location
/Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/services/external-services/docker-compose.yml
```

## Running Perplexica

```bash
# Start all services (including Perplexica)
cd /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/services/external-services
docker-compose up -d

# Start only Perplexica
docker-compose up -d perplexica

# View logs
docker logs aether-perplexica -f

# Rebuild after code changes
docker-compose build perplexica
docker-compose up -d perplexica
```

## Architecture

```
aether-backend/services/
├── external-services/
│   └── docker-compose.yml  ← SINGLE SOURCE OF TRUTH
│       ├── searxng (search)
│       ├── perplexica (AI research) ← builds from ../perplexica/
│       └── supabase-* (persistence)
│
└── Perplexica/
    ├── src/              ← Source code
    ├── Dockerfile        ← Build config (used by external-services compose)
    └── DOCKER_USAGE.md   ← This file
```

## Why Centralized?

1. **Single network**: All services on `aether-network` can communicate
2. **Shared dependencies**: Perplexica needs SearXNG + host services
3. **Consistent environment**: All services use same .env file
4. **No confusion**: One place to manage all containers

## Configuration

Service configuration in `external-services/docker-compose.yml`:

```yaml
perplexica:
  container_name: aether-perplexica
  build:
    context: ../perplexica  # This directory
    dockerfile: Dockerfile
  ports:
    - "3000:3000"
  environment:
    - SEARXNG_API_URL=http://searxng:8080
    - EMBEDDING_SERVICE_URL=http://host.docker.internal:8002/v1
    - LM_STUDIO_BASE_URL=http://host.docker.internal:1234
```

## Development Workflow

```bash
# 1. Make code changes in this directory (src/)

# 2. Rebuild container
cd ../external-services
docker-compose build perplexica

# 3. Restart service
docker-compose up -d perplexica

# 4. Check logs
docker logs aether-perplexica -f
```

## Troubleshooting

**Container not starting?**
```bash
docker-compose logs perplexica
```

**Need fresh build?**
```bash
docker-compose build --no-cache perplexica
```

**Check service health:**
```bash
curl http://localhost:3000/api/health
```
