"""
Incoming: none (pure state management)
Processing: phase transition tracking, new cycle detection --- {2 jobs: JOB_TRACK_STATE, JOB_VALIDATE}
Outgoing: domain → application

Phase State Machine - Domain service for execution phase tracking

Pure business logic, NO I/O.
Manages execution_phase and last_artifact_type for cycle detection.
"""

from typing import Optional


class PhaseStateMachine:
    """
    Domain service for tracking execution phases.
    
    Phases: writing → executing → output
    
    Also detects new code execution cycles:
    - code after output = NEW cycle
    
    Pure state management, NO I/O.
    """
    
    def __init__(self):
        """Initialize phase state machine."""
        self._execution_phase: Optional[str] = None
        self._last_artifact_type: Optional[str] = None
    
    def get_current_phase(self) -> Optional[str]:
        """
        Get current execution phase.
        
        Returns:
            Current phase (writing, executing, output) or None
        """
        return self._execution_phase
    
    def update_phase(self, phase: str) -> bool:
        """
        Update execution phase.
        
        Args:
            phase: New phase (writing, executing, output)
            
        Returns:
            True if phase changed, False if same
        """
        if phase != self._execution_phase:
            self._execution_phase = phase
            return True
        return False
    
    def track_artifact_type(self, artifact_type: str) -> None:
        """
        Track artifact type for cycle detection.
        
        Args:
            artifact_type: Artifact type (code, output)
        """
        if artifact_type in ["code", "output"]:
            self._last_artifact_type = artifact_type
    
    def is_new_code_cycle(self, current_artifact_type: str) -> bool:
        """
        Detect new code execution cycle.
        
        Rule: code artifact AFTER output artifact = NEW cycle
        
        Args:
            current_artifact_type: Current artifact type
            
        Returns:
            True if new cycle detected
        """
        return (
            current_artifact_type == "code"
            and self._last_artifact_type == "output"
        )
    
    def reset(self) -> None:
        """
        Reset phase state (for new subgroup).
        
        Used when creating new subgroup in same group.
        """
        self._execution_phase = None
        # Keep last_artifact_type for cycle detection across subgroups

