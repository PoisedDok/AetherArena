#!/bin/bash

# Aether Backend - Stop Script Bootstrapper
# Delegates to the Python orchestrator inside the binary.

set -euo pipefail

# PATH AUGMENTATION
for _p in /usr/local/bin /opt/homebrew/bin /opt/homebrew/sbin \
          "$HOME/.docker/bin" "$HOME/.pyenv/shims" "$HOME/.local/bin"; do
    [[ -d "$_p" ]] && [[ ":$PATH:" != *":$_p:"* ]] && export PATH="$_p:$PATH"
done
unset _p

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
export AETHER_INSTALL_DIR="$SCRIPT_DIR"

if [ -f "$SCRIPT_DIR/aether-hub/aether-hub" ]; then
    BACKEND_BIN="$SCRIPT_DIR/aether-hub/aether-hub"
elif [ -f "$SCRIPT_DIR/dist/aether-hub/aether-hub" ]; then
    BACKEND_BIN="$SCRIPT_DIR/dist/aether-hub/aether-hub"
elif [ -f "$SCRIPT_DIR/venv/bin/python3" ]; then
    BACKEND_BIN="$SCRIPT_DIR/venv/bin/python3"
else
    BACKEND_BIN="python3"
fi

if [[ "$BACKEND_BIN" == *"aether-hub"* ]]; then
    exec "$BACKEND_BIN" orchestrate --mode stop "$@"
else
    exec "$BACKEND_BIN" "$SCRIPT_DIR/main.py" orchestrate --mode stop "$@"
fi
