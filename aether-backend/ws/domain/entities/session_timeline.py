"""
@.architecture
Incoming: none --- {List[Dict[str, Any]], dict}
Processing: validate timeline ordering, detect sequence gaps, merge event sources --- {3 jobs: JOB_SORT, JOB_TRANSFORM_DATA, JOB_VALIDATE_SCHEMA}
Outgoing: none --- {List[Dict[str, Any]], dict}

Session Timeline Entity - Pure timeline building domain logic

Pure domain logic for building and validating session timelines.
NO I/O, NO external dependencies, NO repository access, framework-agnostic.

Features:
- Event sequence validation
- Timeline merging (messages, trails, artifacts)
- Sequence gap detection
- Chronological ordering
- Duration calculations
"""

from datetime import datetime
from typing import Any, Dict, List, Optional


def validate_sequence_integrity(events: List[Dict[str, Any]]) -> Optional[str]:
    """
    Validate event sequence has no gaps.
    
    Args:
        events: List of timeline events with 'sequence' field
        
    Returns:
        Error message if validation fails, None if valid
        
    Examples:
        validate_sequence_integrity([{"sequence": 1}, {"sequence": 2}]) → None
        validate_sequence_integrity([{"sequence": 1}, {"sequence": 3}]) → "Sequence gap..."
    """
    if not events:
        return None
    
    # Sort by sequence
    sorted_events = sorted(events, key=lambda e: e.get('sequence', 0))
    
    expected = 1
    for event in sorted_events:
        actual = event.get('sequence')
        if actual is None:
            return "Event missing sequence field"
        if actual != expected:
            return f"Sequence gap detected: expected {expected}, got {actual}"
        expected += 1
    
    return None


def merge_timelines(
    *event_lists: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Merge multiple event lists into single chronological timeline.
    
    Combines events from different sources (messages, trails, artifacts)
    and sorts by sequence number.
    
    Args:
        *event_lists: Variable number of event lists to merge
        
    Returns:
        Merged and sorted event list
    """
    merged = []
    for event_list in event_lists:
        merged.extend(event_list)
    
    # Sort by sequence
    merged.sort(key=lambda e: e.get('sequence', 0))
    
    return merged


def calculate_duration_ms(
    start_timestamp: str,
    end_timestamp: str,
) -> Optional[int]:
    """
    Calculate duration between timestamps in milliseconds.
    
    Args:
        start_timestamp: ISO 8601 timestamp
        end_timestamp: ISO 8601 timestamp
        
    Returns:
        Duration in milliseconds, None if parsing fails
        
    Examples:
        calculate_duration_ms("2024-01-01T00:00:00Z", "2024-01-01T00:00:01Z") → 1000
    """
    if not start_timestamp or not end_timestamp:
        return None
    
    try:
        # Parse ISO timestamps, handle 'Z' suffix
        start = datetime.fromisoformat(str(start_timestamp).replace('Z', '+00:00'))
        end = datetime.fromisoformat(str(end_timestamp).replace('Z', '+00:00'))
        
        duration = (end - start).total_seconds() * 1000
        return int(duration)
    except (ValueError, AttributeError):
        return None


def validate_event_has_sequence(event: Dict[str, Any]) -> bool:
    """
    Check if event has required sequence field.
    
    Args:
        event: Event dictionary
        
    Returns:
        True if sequence field present and valid, False otherwise
    """
    sequence = event.get('sequence')
    return sequence is not None and isinstance(sequence, int) and sequence > 0


def get_timeline_bounds(
    timeline: List[Dict[str, Any]]
) -> tuple[Optional[str], Optional[str]]:
    """
    Get first and last timestamps from timeline.
    
    Args:
        timeline: List of events with 'timestamp' field
        
    Returns:
        Tuple of (first_timestamp, last_timestamp), or (None, None) if empty
    """
    if not timeline:
        return (None, None)
    
    first_ts = timeline[0].get('timestamp')
    last_ts = timeline[-1].get('timestamp')
    
    return (first_ts, last_ts)

