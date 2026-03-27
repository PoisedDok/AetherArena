#!/bin/bash
# @.architecture
# Post-build script to copy external services alongside binary
# Incoming: PyInstaller build completion --- {dist/aether-hub/}
# Processing: Copy services to dist/ root --- {rsync, mkdir}
# Outgoing: Complete distribution structure --- {dist/aether-hub/, dist/services/}

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
BACKEND_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_ROOT="$BACKEND_ROOT/dist"

echo "======================================================"
echo "POST-BUILD: Copying external services to dist/"
echo "======================================================"

# Create services directory alongside aether-hub binary
mkdir -p "$DIST_ROOT/services"

# Copy Perplexica source (for Docker build)
echo "📦 Copying Perplexica source..."
rsync -a --exclude='node_modules' \
  "$BACKEND_ROOT/services/perplexica/" \
  "$DIST_ROOT/services/perplexica/"

# Copy external-services configs (docker-compose.yml etc)
echo "📦 Copying external-services configs..."
rsync -a \
  "$BACKEND_ROOT/services/external-services/" \
  "$DIST_ROOT/services/external-services/"

# NOTE: Supabase is NOT copied - user installs it separately
# The docker-compose.yml expects Supabase at ../supabase/ relative to external-services/

# Verify structure
echo ""
echo "✅ Distribution structure:"
tree -L 2 -d "$DIST_ROOT" 2>/dev/null || ls -R "$DIST_ROOT" | grep ":$" | sed 's/:$//' | sed 's/[^-][^\/]*\//--/g'

echo ""
echo "======================================================"
echo "POST-BUILD COMPLETE"
echo "Ship entire dist/ folder (aether-hub + services)"
echo "======================================================"
