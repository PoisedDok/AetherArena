# packages/aether-rag-core/src/aether_rag/__init__.py
import os
import platform

# Fix OpenMP threading issues on macOS ARM64
if platform.system() == "Darwin":
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ["MKL_NUM_THREADS"] = "1"
    os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
    os.environ["KMP_BLOCKTIME"] = "0"
    # Additional fixes for PyTorch/sentence-transformers on macOS ARM64 only in CI
    if os.environ.get("CI") == "true":
        os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "0"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"

from .api import AetherRagBuilder, AetherRagChat, AetherRagSearcher
from .engine import UnifiedRetrievalEngine
from .interfaces import Document, ScoredResult, EnrichedResult

__all__ = [
    "AetherRagBuilder",
    "AetherRagChat",
    "AetherRagSearcher",
    "UnifiedRetrievalEngine",
    "Document",
    "ScoredResult",
    "EnrichedResult",
]
