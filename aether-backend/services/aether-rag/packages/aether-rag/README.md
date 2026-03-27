# Aether-RAG - Local Desktop Semantic and Sparse Search

Aether-RAG is a robust vector and sparse indexing engine tailored for personal AI desktops. Transform your laptop into a powerful hybrid RAG system that uses local embeddings (FAISS) and lexical matching (PyTerrier/BM25) with zero dependencies on cloud infrastructure.

## Installation

```bash
uv pip install aether_rag
```

## Quick Start

```python
from aether_rag import AetherRagBuilder, AetherRagSearcher, AetherRagChat
from pathlib import Path
INDEX_PATH = str(Path("./").resolve() / "demo.aether-rag")

# Build a hybrid index
builder = AetherRagBuilder()
builder.add_text("Aether-RAG provides robust local hybrid search.")
builder.add_text("Tung Tung Tung Sahur called—they need their banana‑crocodile hybrid back")
builder.build_index(INDEX_PATH)

# Search
searcher = AetherRagSearcher(INDEX_PATH)
results = searcher.search("fantastical AI-generated creatures", top_k=1, mode="hybrid")

# Chat with your data
chat = AetherRagChat(INDEX_PATH, llm_config={"type": "hf", "model": "Qwen/Qwen3-0.6B"})
response = chat.ask("What kind of search does Aether-RAG provide?", top_k=1)
```

## License

MIT License
