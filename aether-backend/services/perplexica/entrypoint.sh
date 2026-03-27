#!/bin/sh
set -e

echo "Starting Perplexica Backend..."

# Standalone mode expects node server.js
cd /home/perplexica
exec node server.js
