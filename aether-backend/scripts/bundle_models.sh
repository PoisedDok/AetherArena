#!/bin/bash

# Aether - Model Bundling Script
# Collects key ML models into the backend directory for packaging

set -e

BACKEND_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
MODELS_DIR="$BACKEND_ROOT/models"

echo "📂 Creating models directory: $MODELS_DIR"
mkdir -p "$MODELS_DIR"

# 1. Embedding Model — NOW RUNS INSIDE Perplexica Docker (ONNX)
# No host-side bundling needed. See services/perplexica/Dockerfile.
HF_CACHE="$HOME/.cache/huggingface/hub"

# 2. Whisper (openai/whisper-small)
WHISPER_MODEL_CACHE="$HF_CACHE/models--openai--whisper-small"

if [ -d "$WHISPER_MODEL_CACHE" ]; then
    echo "✅ Found Whisper Model in cache"
    SNAPSHOT=$(ls -t "$WHISPER_MODEL_CACHE/snapshots" | head -n 1)
    SOURCE="$WHISPER_MODEL_CACHE/snapshots/$SNAPSHOT"
    DEST="$MODELS_DIR/stt/whisper-small"
    
    echo "🚚 Copying Whisper Model to $DEST..."
    mkdir -p "$DEST"
    cp -R "$SOURCE/"* "$DEST/"
else
    echo "⚠️  Whisper Model not found in cache."
fi

# 3. Pyannote Segmentation (pyannote/segmentation-3.0)
VAD_MODEL_CACHE="$HF_CACHE/models--pyannote--segmentation-3.0"

if [ -d "$VAD_MODEL_CACHE" ]; then
    echo "✅ Found VAD Model in cache"
    SNAPSHOT=$(ls -t "$VAD_MODEL_CACHE/snapshots" | head -n 1)
    SOURCE="$VAD_MODEL_CACHE/snapshots/$SNAPSHOT"
    DEST="$MODELS_DIR/vad/segmentation-3.0"
    
    echo "🚚 Copying VAD Model to $DEST..."
    mkdir -p "$DEST"
    cp -R "$SOURCE/"* "$DEST/"
else
    echo "⚠️  VAD Model not found in cache."
fi

echo "✅ Model bundling complete"
