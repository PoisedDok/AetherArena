"""
Storage Layer - File storage management

Provides file system storage operations:
- Local file storage with type-based organization
- Path management and validation
- Metadata tracking

The storage layer handles physical file persistence while
the database layer tracks metadata and relationships.
"""

from .local import LocalFileStorage

__all__ = ["LocalFileStorage"]

