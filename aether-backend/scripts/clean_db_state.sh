#!/bin/bash
set -euo pipefail

echo "======================================================"
echo "🧹 AetherArena Database Cleaner"
echo "======================================================"

echo "[1/4] Stopping backend process..."
pkill -f aether-backend || true

echo "[2/4] Stopping docker mesh (only aether containers)..."
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/../services/external-services" || exit 1

# Take down the specific aether-mesh compose safely
docker compose down -v || echo "Docker compose down failed or already down."

echo "[3/4] Cleaning local development data volumes..."
# We only delete the problematic state: DB, and Storage.
# We do NOT touch Perplexica/SearXNG state or downloaded models.
# IMPORTANT: Do not delete volumes/logs or volumes/api, they contain required config templates (vector.yml, kong.yml).
rm -rf volumes/db/data
rm -rf volumes/storage

echo "[4/4] Cleaning macOS production data volumes..."
# Default location in packaged app
DATA_ROOT="$HOME/Library/Application Support/Aether"

if [ -d "$DATA_ROOT" ]; then
    # We clean docker data and local db file but KEEP models and venvs
    rm -rf "$DATA_ROOT/docker-data/db/data"
    rm -rf "$DATA_ROOT/docker-data/storage"
    rm -rf "$DATA_ROOT/database"
    rm -rf "$DATA_ROOT/config/local.env"
    rm -rf "$DATA_ROOT/logs"
fi

echo "======================================================"
echo "✅ Clean up complete."
echo "You can now run './start_dev.sh' to get a fresh start."
echo "Your downloaded models and Python environments are safe."
echo "======================================================"
