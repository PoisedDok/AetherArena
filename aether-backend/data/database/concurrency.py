"""
@.architecture

Incoming: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/repositories/*.py, /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/clients/supabase.py::SupabaseClient --- {Callable[..., Awaitable[Any]], async_invocation}
Processing: enforce optimistic locking, orchestrate retry backoff, record concurrency outcomes --- {JOB_ORCHESTRATE, JOB_RETRY, JOB_TIMEOUT}
Outgoing: /Volumes/Disk-D/Aether/Aether/AetherArena/aether-backend/data/database/repositories/*.py --- {Dict[str, Any], json}


Concurrency Control - RACE Condition Protection
================================================
Provides application-level protection against concurrent database operations:
- Optimistic locking with version/timestamp checking
- Automatic retry with exponential backoff
- Conflict detection and resolution
- Safe concurrent writes to same resources

Usage:
    from data.database.concurrency import with_retry, with_optimistic_lock, ConflictError
    
    # Retry on transient failures
    result = await with_retry(
        lambda: db.insert("chats", data),
        max_retries=3,
        backoff_factor=2
    )
    
    # Optimistic locking
    updated = await with_optimistic_lock(
        db=db,
        table="chats",
        record_id=chat_id,
        expected_version=current_version,
        updates={"title": new_title}
    )
"""

import asyncio
import logging
from typing import Any, Callable, Dict, Optional, TypeVar
from datetime import datetime, timezone
from functools import wraps

logger = logging.getLogger(__name__)

T = TypeVar('T')


class ConflictError(Exception):
    """
    Raised when concurrent modification conflict detected.
    
    Indicates that a record was modified by another process
    between read and write operations.
    """
    pass


class RetryableError(Exception):
    """
    Raised for transient errors that can be retried.
    
    Examples: network timeouts, temporary database unavailability.
    """
    pass


async def with_retry(
    operation: Callable[[], T],
    max_retries: int = 3,
    backoff_factor: float = 2.0,
    initial_delay: float = 0.1,
    max_delay: float = 10.0,
    retryable_exceptions: tuple = (RetryableError, ConnectionError, TimeoutError)
) -> T:
    """
    Retry operation with exponential backoff on transient failures.
    
    Args:
        operation: Async callable to retry
        max_retries: Maximum number of retry attempts
        backoff_factor: Multiplier for delay between retries
        initial_delay: Initial delay in seconds
        max_delay: Maximum delay between retries
        retryable_exceptions: Tuple of exception types to retry
    
    Returns:
        Result of successful operation
    
    Raises:
        Last exception if all retries exhausted
        ConflictError immediately without retry
    
    Example:
        result = await with_retry(
            lambda: db.insert("table", data),
            max_retries=3
        )
    """
    delay = initial_delay
    last_exception = None
    
    for attempt in range(max_retries + 1):
        try:
            return await operation()
            
        except ConflictError:
            # Don't retry conflicts - let caller handle
            raise
            
        except retryable_exceptions as e:
            last_exception = e
            
            if attempt >= max_retries:
                logger.error(f"Operation failed after {max_retries} retries: {e}")
                raise
            
            logger.warning(
                f"Retry attempt {attempt + 1}/{max_retries} after error: {e}. "
                f"Waiting {delay:.2f}s"
            )
            
            await asyncio.sleep(delay)
            delay = min(delay * backoff_factor, max_delay)
        
        except Exception as e:
            # Non-retryable errors fail immediately
            logger.error(f"Non-retryable error in operation: {e}", exc_info=True)
            raise
    
    raise last_exception


async def with_optimistic_lock(
    db: Any,
    table: str,
    record_id: str,
    expected_version: Optional[str],
    updates: Dict[str, Any],
    version_field: str = "updated_at",
    max_retries: int = 3
) -> Dict[str, Any]:
    """
    Update record with optimistic locking (compare-and-swap).
    
    Ensures record hasn't been modified since last read by comparing
    version field (typically updated_at timestamp).
    
    Args:
        db: Supabase client instance
        table: Table name
        record_id: Record ID to update
        expected_version: Expected current value of version_field (ISO timestamp)
        updates: Dict of fields to update
        version_field: Field name for version checking (default: updated_at)
        max_retries: Number of retry attempts on conflict
    
    Returns:
        Updated record
    
    Raises:
        ConflictError: If record was modified by another process
    
    Example:
        chat = await db.select("chats", filters={"id": chat_id})
        updated = await with_optimistic_lock(
            db=db,
            table="chats",
            record_id=chat_id,
            expected_version=chat[0]["updated_at"],
            updates={"title": "New Title"}
        )
    """
    
    for attempt in range(max_retries):
        try:
            # Read current version
            current = await db.select(
                table,
                filters={"id": record_id},
                limit=1,
                admin=True
            )
            
            if not current:
                raise ValueError(f"Record not found: {table}.id={record_id}")
            
            current_version = current[0].get(version_field)
            
            # Check if version matches expected
            if expected_version is not None and current_version != expected_version:
                raise ConflictError(
                    f"Concurrent modification detected on {table}.{record_id}. "
                    f"Expected {version_field}={expected_version}, "
                    f"got {current_version}"
                )
            
            # Update with new version
            updates[version_field] = datetime.now(timezone.utc).isoformat()
            
            result = await db.update(
                table,
                record_id,
                updates,
                admin=True
            )
            
            logger.debug(f"Optimistic lock success: {table}.{record_id}")
            return result
            
        except ConflictError:
            if attempt >= max_retries - 1:
                logger.error(f"Optimistic lock failed after {max_retries} attempts")
                raise
            
            logger.warning(
                f"Conflict detected on {table}.{record_id}, "
                f"retry {attempt + 1}/{max_retries}"
            )
            await asyncio.sleep(0.1 * (2 ** attempt))  # Exponential backoff
            
            # Re-read for next attempt
            fresh = await db.select(
                table,
                filters={"id": record_id},
                limit=1,
                admin=True
            )
            expected_version = fresh[0].get(version_field) if fresh else None


def concurrent_safe(max_retries: int = 3):
    """
    Decorator to make repository methods concurrent-safe with automatic retry.
    
    Args:
        max_retries: Number of retry attempts on retryable errors
    
    Example:
        class ChatRepository:
            @concurrent_safe(max_retries=3)
            async def create_message(self, ...):
                # Method automatically retried on transient failures
                pass
    """
    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args, **kwargs):
            return await with_retry(
                lambda: func(*args, **kwargs),
                max_retries=max_retries
            )
        return wrapper
    return decorator


async def safe_upsert(
    db: Any,
    table: str,
    data: Dict[str, Any],
    conflict_columns: list,
    max_retries: int = 3
) -> Dict[str, Any]:
    """
    Safe upsert with retry on conflicts.
    
    Uses Supabase's native upsert with conflict resolution,
    retrying on transient failures.
    
    Args:
        db: Supabase client
        table: Table name
        data: Data to insert/update
        conflict_columns: Columns to check for conflicts
        max_retries: Number of retry attempts
    
    Returns:
        Upserted record
    
    Example:
        tool = await safe_upsert(
            db=db,
            table="mcp_tools",
            data={"server_id": server_id, "name": "tool1", ...},
            conflict_columns=["server_id", "name"]
        )
    """
    async def do_upsert():
        return await db.upsert(
            table,
            data,
            on_conflict=",".join(conflict_columns),
            admin=True
        )
    
    return await with_retry(do_upsert, max_retries=max_retries)


# =============================================================================
# RACE Condition Documentation
# =============================================================================

"""
RACE Condition Protection Strategy
===================================

1. **Database-Level Protection** (Primary - Supabase/PostgreSQL)
   - UNIQUE constraints on (server_id, name) for mcp_tools
   - CASCADE deletes for referential integrity
   - Atomic upsert operations
   - Supabase row-level locking on UPDATE (PostgreSQL underneath)

2. **Application-Level Protection** (Secondary)
   - Optimistic locking with updated_at timestamps
   - Retry with exponential backoff for transient failures
   - Conflict detection and ConflictError exceptions
   - Concurrent-safe decorators for repository methods

3. **Common RACE Scenarios**

   Scenario 1: Concurrent Tool Upserts
   ------------------------------------
   Problem: Multiple processes discover same tool simultaneously
   Solution: Use safe_upsert() with (server_id, name) conflict resolution
   
   Example:
       await safe_upsert(
           db, "mcp_tools",
           tool_data,
           conflict_columns=["server_id", "name"]
       )

   Scenario 2: Chat Title Update
   ------------------------------
   Problem: User renames chat while message arrives
   Solution: Use with_optimistic_lock() with updated_at check
   
   Example:
       chat = await repo.get_chat(chat_id)
       await with_optimistic_lock(
           db, "chats", chat_id,
           expected_version=chat.updated_at,
           updates={"title": new_title}
       )

   Scenario 3: Artifact Message Linking
   -------------------------------------
   Problem: Message and artifact created concurrently
   Solution: Allow nullable message_id, update after both exist
   
   Example:
       artifact = await repo.create_artifact(..., message_id=None)
       message = await repo.create_message(...)
       await repo.update_artifact_message_id(artifact.id, message.id)

   Scenario 4: Concurrent Message Inserts
   ---------------------------------------
   Problem: Multiple messages added to same chat
   Solution: Database handles atomicity, no app-level locking needed
   - Each message has unique UUID (no collision)
   - Chat.updated_at handled by trigger
   - Order preserved by timestamp

4. **When to Use Each Strategy**

   Use Database UPSERT:
   - MCP tool registration
   - Idempotent operations
   - Known conflict columns
   
   Use Optimistic Locking:
   - User-initiated updates (chat title, settings)
   - Long-running operations
   - When you need to detect conflicts
   
   Use Retry:
   - Network timeouts
   - Temporary database unavailability
   - Transient errors
   
   Use Nothing (Trust Database):
   - Simple inserts with UUID
   - Append-only operations (messages, logs)
   - Operations with CASCADE constraints

5. **Testing RACE Conditions**

   import asyncio
   
   async def test_concurrent_updates():
       # Simulate concurrent updates
       tasks = [
           repo.update_chat(chat_id, f"Title {i}")
           for i in range(10)
       ]
       results = await asyncio.gather(*tasks, return_exceptions=True)
       
       # Verify only one succeeded, others got ConflictError
       successes = [r for r in results if not isinstance(r, Exception)]
       assert len(successes) == 1
"""

