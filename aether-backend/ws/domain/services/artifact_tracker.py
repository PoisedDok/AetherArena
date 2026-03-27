"""
Incoming: none (pure state management)
Processing: artifact ID tracking, linked artifact deduplication --- {2 jobs: JOB_TRACK_STATE, JOB_VALIDATE}
Outgoing: domain → application

Artifact Tracker - Domain service for artifact state management

Pure business logic, NO I/O.
Manages artifact_id_map and linked_artifacts set.
"""

from typing import Dict, Set, Optional


class ArtifactTracker:
    """
    Domain service for tracking artifacts during stream processing.
    
    Manages:
    - artifact_id_map: Maps event types to artifact IDs
    - linked_artifacts: Set of already-linked artifact IDs (deduplication)
    
    Pure state management, NO I/O.
    """
    
    def __init__(self):
        """Initialize artifact tracker."""
        self._artifact_id_map: Dict[str, str] = {}
        self._linked_artifacts: Set[str] = set()
    
    def store_artifact_id(
        self,
        event_type: str,
        artifact_id: str,
        raw_type: Optional[str] = None,
    ) -> None:
        """
        Store artifact ID for an event type.
        
        Args:
            event_type: Normalized event type (code, output)
            artifact_id: Artifact identifier
            raw_type: Optional raw type for legacy mapping
        """
        self._artifact_id_map[event_type] = artifact_id
        
        # Also store under raw type if different (for legacy types)
        if raw_type and raw_type != event_type:
            self._artifact_id_map[raw_type] = artifact_id
    
    def get_artifact_id(
        self,
        event_type: str,
        raw_type: Optional[str] = None,
        original_type: Optional[str] = None,
    ) -> Optional[str]:
        """
        Retrieve artifact ID for event type.
        
        Tries multiple lookups:
        1. Normalized event_type
        2. Raw type (before normalization)
        3. Original type (console, etc.)
        
        Args:
            event_type: Normalized event type
            raw_type: Optional raw type
            original_type: Optional original type
            
        Returns:
            Artifact ID if found, None otherwise
        """
        # Try normalized type first
        if event_type in self._artifact_id_map:
            return self._artifact_id_map[event_type]
        
        # Try raw type
        if raw_type and raw_type in self._artifact_id_map:
            return self._artifact_id_map[raw_type]
        
        # Try original type
        if original_type and original_type in self._artifact_id_map:
            return self._artifact_id_map[original_type]
        
        return None
    
    def is_already_linked(self, artifact_id: str) -> bool:
        """
        Check if artifact is already linked (deduplication).
        
        Args:
            artifact_id: Artifact identifier
            
        Returns:
            True if already linked, False otherwise
        """
        return artifact_id in self._linked_artifacts
    
    def mark_as_linked(self, artifact_id: str) -> None:
        """
        Mark artifact as linked (prevents duplicate linking).
        
        Args:
            artifact_id: Artifact identifier
        """
        self._linked_artifacts.add(artifact_id)
    
    def clear_linked(self) -> None:
        """
        Clear linked artifacts set.
        
        Used when creating new subgroup (new execution cycle).
        """
        self._linked_artifacts.clear()
    
    def reset(self) -> None:
        """
        Reset tracker state.
        
        Clears both artifact ID map and linked artifacts set.
        Used when starting a fresh execution cycle.
        """
        self._artifact_id_map.clear()
        self._linked_artifacts.clear()
    
    def has_artifact_type(self, artifact_type: str) -> bool:
        """
        Check if artifact type has been stored.
        
        Args:
            artifact_type: Artifact type to check
            
        Returns:
            True if artifact_type exists in map
        """
        return artifact_type in self._artifact_id_map

