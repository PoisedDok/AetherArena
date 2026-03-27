# AetherArena Evaluator Manual

This manual is for readers who need to build, run, and inspect the project from source without guessing where the real architecture lives.

## 1. System requirements

- macOS or Linux
- Python 3.9+
- Node.js 18+
- Docker and Docker Compose for the mesh-backed services

## 2. Source setup

### Backend

```bash
cd aether-backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Frontend

```bash
cd aether-frontend
npm install
cp env.example .env
```

## 3. Running the system

### Backend

```bash
cd aether-backend
source venv/bin/activate
bash start_production.sh
```

`start_production.sh` is the backend bootstrap entry point. In source mode it delegates to `main.py orchestrate`.

### Frontend

```bash
cd aether-frontend
npm run dev
```

## 4. Where to inspect the implementation

### Architecture

- `docs/architecture/system-architecture.md`
- `docs/architecture/backend-architecture.md`
- `docs/architecture/frontend-architecture.md`
- `docs/architecture/API_DOCUMENTATION.md`

### Proactive pipeline

- `docs/PROACTIVE_SYSTEM_DEEP_DIVE.md`
- `aether-backend/services/daemons/`
- `aether-backend/workers/handlers/proactive_agent_handler.py`
- `aether-backend/api/v1/endpoints/proactive.py`

### Contracts

- `contracts/`

### Local inference

- `aether-backend/services/aether_inference/`

### Desktop security boundary

- `aether-frontend/src/main/security/`
- `aether-frontend/src/preload/`

## 5. Running tests

### Backend

```bash
cd aether-backend
source venv/bin/activate
pytest
```

### Frontend

```bash
cd aether-frontend
npm test
```

## 6. Additional documentation

Start at `docs/index.md` for the maintained project documentation set.
