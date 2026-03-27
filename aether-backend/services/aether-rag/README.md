# Aether-RAG

Aether-RAG is a research-grade desktop retrieval platform. It turns your local machine into a personal intelligence engine.

The system runs entirely on your laptop. No cloud dependencies. No hidden telemetry. Your data stays on your disk.

## The Architecture

We built Aether-RAG around a strict V2 Hexagonal Architecture. It isolates volatile dependencies into separate processes and unifies retrieval through a clean orchestration layer.

### Three Pipelines

1. **Semantic Search (Dense)**. We use FAISS with an HNSW index, held entirely in memory. It maps vectors to document IDs directly. To keep the main process fast, we isolated PyTorch and the ML models in a separate ZMQ sidecar. It supports Perplexica ONNX, Ollama, and OpenAI-compatible endpoints natively.
2. **Keyword Search (Sparse)**. We use PyTerrier for BM25. PyTerrier relies on a JVM. Running a JVM in the same process as Python causes memory leaks and thread crashes. So we isolated PyTerrier in its own sidecar process. We enforce a strict "always rebuild" policy for sparse indexes to prevent statistical drift.
3. **Hybrid Search (Fusion)**. We combine dense and sparse results using Weighted Reciprocal Rank Fusion (W-RRF). Our fusion logic strictly follows the `ranx` mathematical formulation. If a document misses a rank, it contributes exactly 0.0. No penalty hacks.

### Engineering Standards

- **Hexagonal Boundaries**: The API facade knows nothing about FAISS or PyTerrier. The `UnifiedRetrievalEngine` routes traffic to specific `IEmbeddingProvider`, `IVectorStore`, and `ISparseStore` implementations.
- **Fail-Fast Hydration**: If the SQLite document store misses an ID from the FAISS or PyTerrier index, the system throws a `RuntimeError`. We do not patch or hide index drift.
- **Batched Inference**: The tokenization utility uses `tiktoken` to rapidly truncate texts before passing them to the embedding providers. Providers batch requests internally to max out throughput.

## Installation

[Install uv](https://docs.astral.sh/uv/getting-started/installation/#installation-methods) first if you do not have it.

```bash
git clone https://github.com/aether-arena/AetherArena.git
cd AetherArena/aether-backend/services/aether-rag
uv venv
source .venv/bin/activate
uv pip install -e .
```

## Quick Start

Our declarative API makes RAG simple.

```python
from aether_rag import AetherRagBuilder, AetherRagSearcher
from pathlib import Path

INDEX_PATH = str(Path("./").resolve() / "demo.index")

# Build the index
builder = AetherRagBuilder(
    embedding_model="BAAI/bge-small-en-v1.5",
    embedding_mode="sentence-transformers",
    enable_bm25=True
)
builder.add_text("Aether-RAG saves storage and runs locally.")
builder.build_index(INDEX_PATH)

# Search
searcher = AetherRagSearcher(INDEX_PATH)
results = searcher.search("local storage", mode="hybrid", top_k=5)

for r in results:
    print(f"[{r.score:.3f}] {r.text}")
```

## Supported Backends

You can run embeddings locally via the PyTorch sidecar, or route them to external servers.

- **Perplexica ONNX / Aether Inference** (Default for AetherArena)
- **Ollama** (`embedding_mode="ollama"`)
- **OpenAI API** (`embedding_mode="openai"`)

Set your API keys via environment variables or pass them in the `embedding_options` dictionary.

## RAG on Everything

Aether-RAG ships with applications to index your personal data. Each app uses the core engines to process and search your data locally.

- **Documents**: `python -m apps.document_rag` (PDF, TXT, MD)
- **Apple Mail**: `python -m apps.email_rag`
- **Browser History**: `python -m apps.browser_rag`
- **WeChat/iMessage**: `python -m apps.wechat_rag` / `python -m apps.imessage_rag`
- **Claude/ChatGPT**: `python -m apps.claude_rag` / `python -m apps.chatgpt_rag`
- **Live Data via MCP**: `python -m apps.slack_rag` / `python -m apps.twitter_rag`

All apps support the same configuration parameters for embedding models, chunking, and search complexity. Run any app with `--help` to see options.

## Running Tests

We test everything adversarially.

```bash
uv run pytest -v packages/aether-rag-core/tests/
```

Tests run against the core tokenization limits, provider interfaces, and pipeline integration.