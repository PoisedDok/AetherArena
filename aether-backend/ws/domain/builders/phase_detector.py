"""
@.architecture
Incoming: none --- {str, str, Optional[str], primitives}
Processing: detect execution phase from role/type/format triplet --- {2 jobs: JOB_ROUTE_BY_TYPE, JOB_TRANSFORM_DATA}
Outgoing: none --- {Optional[str], primitive}

Phase Detector - Pure execution phase detection logic

Pure domain logic for detecting execution phases from stream events.
NO I/O, NO external dependencies, framework-agnostic.

Phases:
- writing: Assistant is writing code (assistant:code)
- executing: Computer echoes code / emits console output (computer:code, computer:output+console)
- output: Computer is producing final output (computer:output+html/json/markdown/text)

ARCHITECTURE: See contracts/README.md (Trail hierarchy + phase invariants)
- assistant:code → writing phase (code authoring)
- computer:code → executing phase (code echo = execution started)
- computer:output+console → executing phase (runtime console logs)
- computer:output+{html,json,markdown,text} → output phase (rendered results)
"""

from typing import Optional


# Valid execution phases in order
EXECUTION_PHASES = ["writing", "executing", "output"]


def detect_phase(
    role: str,
    event_type: str,
    event_format: Optional[str] = None,
) -> Optional[str]:
    """
    Detect execution phase from event characteristics.
    
    Implements pure phase detection logic without side effects.
    
    Args:
        role: Event role (assistant, computer, user)
        event_type: Event type (code, output, message)
        event_format: Optional format field (console, html, json, text, python, etc.)
        
    Returns:
        Phase string if detected, None if not a phase-triggering event
        
    Phase Rules:
        assistant:code → "writing" (code authoring)
        computer:code → "executing" (code echo = execution started)
        computer:output+console → "executing" (runtime console logs)
        computer:output+{html,json,markdown,text} → "output" (rendered results)
        
    Examples:
        detect_phase("assistant", "code", "python") → "writing"
        detect_phase("computer", "code", "python") → "executing"
        detect_phase("computer", "output", "console") → "executing"
        detect_phase("computer", "output", "html") → "output"
    """
    role_lower = role.lower()
    type_lower = event_type.lower()
    format_lower = event_format.lower() if event_format else None
    
    # PHASE 1: Writing (assistant authors code)
    if role_lower == "assistant" and type_lower == "code":
        return "writing"
    
    # PHASE 1→2 TRANSITION: Code echo (computer reflects code back)
    # When OI echoes back the code block, execution has started.
    # Returning "executing" here causes a writing→executing phase transition
    # in the PhaseStateMachine, which:
    #   (a) Prevents premature trail completion (new_phase is NOT None)
    #   (b) Keeps trail_hierarchy alive for _process_artifact_event to
    #       correctly mark writing→completed, executing→active
    if role_lower == "computer" and type_lower == "code":
        return "executing"
    
    # PHASE 2: Executing (computer emits console output during execution)
    if role_lower == "computer" and type_lower == "output" and format_lower == "console":
        return "executing"
    
    # PHASE 3: Output (computer produces final rendered output)
    # html, json, markdown, text are final output types
    if role_lower == "computer" and type_lower == "output":
        # Any output that is NOT console is final output
        if format_lower and format_lower != "console":
            return "output"
    
    return None


def is_phase_transition(
    current_phase: Optional[str],
    new_phase: Optional[str],
) -> bool:
    """
    Determine if a phase transition is occurring.
    
    Args:
        current_phase: Current execution phase
        new_phase: Newly detected phase
        
    Returns:
        True if this is a valid phase transition, False otherwise
        
    Examples:
        is_phase_transition(None, "writing") → True (start)
        is_phase_transition("writing", "executing") → True (progression)
        is_phase_transition("writing", "writing") → False (no change)
        is_phase_transition("executing", None) → False (no transition)
    """
    # No transition if new phase is None or same as current
    if new_phase is None or new_phase == current_phase:
        return False
    
    # Valid transition: any change to a new phase
    return True


def validate_phase(phase: Optional[str]) -> bool:
    """
    Validate if a phase string is valid.
    
    Args:
        phase: Phase to validate
        
    Returns:
        True if valid phase or None, False otherwise
    """
    if phase is None:
        return True
    return phase in EXECUTION_PHASES

