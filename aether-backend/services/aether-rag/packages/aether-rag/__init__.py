"""
Aether-RAG - Low-storage Embedding Approximation for Neural Networks

A revolutionary vector database that democratizes personal AI.
"""

__version__ = "0.1.0"

# Re-export main API from aether-rag-core
from aether_rag_core import AetherRagBuilder, AetherRagChat, AetherRagSearcher

__all__ = ["AetherRagBuilder", "AetherRagChat", "AetherRagSearcher"]
