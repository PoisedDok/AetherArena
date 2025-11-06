"""
Database Connection Manager

@.architecture
Incoming: app.py (startup_event), api/dependencies.py, data/database/repositories/*.py, data/database/migrations/*.sql --- {connection URL, pool config, schema SQL files, repository connection/transaction requests}
Processing: connect(), disconnect(), get_connection(), transaction(), initialize_schema(), verify_schema(), health_check(), get_diagnostics(), execute(), fetch_one(), fetch_all() --- {11 jobs: connection_pooling, lifecycle_management, transaction_management, schema_initialization, health_monitoring, query_execution}
Outgoing: PostgreSQL (via psycopg AsyncConnectionPool), api/dependencies.py, data/database/repositories/*.py --- {async connection pool, AsyncGenerator[connection] context managers, health status Dict, query results}

Production-ready async PostgreSQL connection management with:
- Async connection pooling (psycopg[pool])
- Transaction management with context managers
- Health checks and diagnostics
- Schema initialization
- Graceful shutdown and cleanup
- Connection lifecycle tracking

Security Features:
- Connection pool limits
- Timeout management
- SQL injection prevention via prepared statements
- Connection validation
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from monitoring import get_logger

logger = get_logger(__name__)


class DatabaseConnection:
    """
    Async PostgreSQL connection manager with pooling and lifecycle management.
    
    Features:
    - Async connection pool with configurable limits
    - Transaction context managers
    - Schema initialization from SQL files
    - Health checks and diagnostics
    - Connection validation
    - Graceful shutdown
    
    Usage:
        # Initialize
        db = DatabaseConnection(connection_url)
        await db.connect()
        
        # Use connection
        async with db.get_connection() as conn:
            result = await conn.execute("SELECT * FROM chats")
        
        # Use transaction
        async with db.transaction() as conn:
            await conn.execute("INSERT INTO chats ...")
        
        # Cleanup
        await db.disconnect()
    """
    
    def __init__(
        self,
        connection_url: str,
        min_size: int = 5,
        max_size: int = 20,
        max_idle: float = 300.0,  # 5 minutes
        timeout: float = 30.0,
    ):
        """
        Initialize database connection manager.
        
        Args:
            connection_url: PostgreSQL connection URL (postgresql://user:pass@host:port/db)
            min_size: Minimum pool size
            max_size: Maximum pool size
            max_idle: Maximum idle time before connection recycling (seconds)
            timeout: Connection acquisition timeout (seconds)
        """
        self.connection_url = connection_url
        self.min_size = min_size
        self.max_size = max_size
        self.max_idle = max_idle
        self.timeout = timeout
        
        self._pool: Optional[AsyncConnectionPool] = None
        self._connected = False
        self._schema_initialized = False
    
    # =========================================================================
    # CONNECTION LIFECYCLE
    # =========================================================================
    
    async def connect(self) -> None:
        """
        Initialize connection pool.
        
        Raises:
            RuntimeError: If pool already initialized
            Exception: If connection fails
        """
        if self._connected:
            logger.warning("Database pool already connected")
            return
        
        try:
            logger.info("Initializing database connection pool...")
            
            # Create async connection pool
            self._pool = AsyncConnectionPool(
                conninfo=self.connection_url,
                min_size=self.min_size,
                max_size=self.max_size,
                max_idle=self.max_idle,
                timeout=self.timeout,
                kwargs={"row_factory": dict_row},  # Return rows as dicts
            )
            
            # Wait for pool to be ready
            await self._pool.wait()
            
            self._connected = True
            logger.info(
                f"✅ Database pool initialized "
                f"(min={self.min_size}, max={self.max_size})"
            )
            
        except Exception as e:
            logger.error(f"Failed to initialize database pool: {e}", exc_info=True)
            self._pool = None
            raise
    
    async def disconnect(self) -> None:
        """Close connection pool and cleanup."""
        if not self._connected or not self._pool:
            return
        
        try:
            logger.info("Closing database connection pool...")
            await self._pool.close()
            self._pool = None
            self._connected = False
            self._schema_initialized = False
            logger.info("✅ Database pool closed")
            
        except Exception as e:
            logger.error(f"Error closing database pool: {e}")
    
    # =========================================================================
    # CONNECTION ACCESS
    # =========================================================================
    
    @asynccontextmanager
    async def get_connection(self) -> AsyncGenerator:
        """
        Get a connection from the pool (async context manager).
        
        Usage:
            async with db.get_connection() as conn:
                result = await conn.execute("SELECT * FROM chats")
        
        Yields:
            Async connection object
            
        Raises:
            RuntimeError: If pool not initialized
        """
        if not self._connected or not self._pool:
            raise RuntimeError(
                "Database not connected. Call connect() first."
            )
        
        conn = None
        try:
            async with self._pool.connection() as conn:
                yield conn
        except Exception as e:
            logger.error(f"Connection error: {e}")
            raise
    
    @asynccontextmanager
    async def transaction(self) -> AsyncGenerator:
        """
        Transaction context manager with automatic commit/rollback.
        
        Usage:
            async with db.transaction() as conn:
                await conn.execute("INSERT INTO chats ...")
                await conn.execute("INSERT INTO messages ...")
        
        Yields:
            Async connection with active transaction
            
        Raises:
            RuntimeError: If pool not initialized
        """
        if not self._connected or not self._pool:
            raise RuntimeError(
                "Database not connected. Call connect() first."
            )
        
        async with self._pool.connection() as conn:
            async with conn.transaction():
                yield conn
    
    # =========================================================================
    # SCHEMA MANAGEMENT
    # =========================================================================
    
    async def initialize_schema(
        self,
        schema_file: Path,
        force: bool = False
    ) -> None:
        """
        Initialize database schema from SQL file.
        
        Args:
            schema_file: Path to SQL schema file
            force: If True, drop existing tables before creating
            
        Raises:
            FileNotFoundError: If schema file not found
            Exception: If schema execution fails
        """
        if not schema_file.exists():
            raise FileNotFoundError(f"Schema file not found: {schema_file}")
        
        try:
            logger.info(f"Initializing schema from {schema_file.name}...")
            
            # Read schema SQL
            schema_sql = schema_file.read_text()
            
            async with self.transaction() as conn:
                if force:
                    logger.warning("Force mode: dropping existing tables")
                    # Drop tables in reverse dependency order
                    await conn.execute("DROP TABLE IF EXISTS artifacts CASCADE")
                    await conn.execute("DROP TABLE IF EXISTS messages CASCADE")
                    await conn.execute("DROP TABLE IF EXISTS chats CASCADE")
                    await conn.execute("DROP VIEW IF EXISTS chat_list CASCADE")
                    await conn.execute("DROP VIEW IF EXISTS messages_with_metadata CASCADE")
                
                # Execute schema SQL
                await conn.execute(schema_sql)
            
            self._schema_initialized = True
            logger.info(f"✅ Schema initialized from {schema_file.name}")
            
        except Exception as e:
            logger.error(f"Schema initialization failed: {e}", exc_info=True)
            raise
    
    async def verify_schema(self, required_tables: list[str]) -> bool:
        """
        Verify that required tables exist.
        
        Args:
            required_tables: List of table names to check
            
        Returns:
            True if all tables exist, False otherwise
        """
        try:
            async with self.get_connection() as conn:
                # Query information schema
                cursor = await conn.execute(
                    """
                    SELECT table_name 
                    FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_type = 'BASE TABLE'
                    """
                )
                tables = [row["table_name"] async for row in cursor]
                
                # Check for missing tables
                missing = [t for t in required_tables if t not in tables]
                
                if missing:
                    logger.error(f"Missing tables: {missing}")
                    return False
                
                logger.info(f"✅ Schema verification passed ({len(required_tables)} tables)")
                return True
                
        except Exception as e:
            logger.error(f"Schema verification failed: {e}")
            return False
    
    # =========================================================================
    # HEALTH CHECKS
    # =========================================================================
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Perform database health check.
        
        Returns:
            Dict with health status information
        """
        result = {
            "healthy": False,
            "connected": self._connected,
            "schema_initialized": self._schema_initialized,
            "error": None,
        }
        
        if not self._connected or not self._pool:
            result["error"] = "Pool not connected"
            return result
        
        try:
            async with self.get_connection() as conn:
                # Simple query to test connection
                cursor = await conn.execute("SELECT 1 AS test")
                row = await cursor.fetchone()
                
                if row and row["test"] == 1:
                    result["healthy"] = True
                    
                    # Get pool statistics
                    result["pool_stats"] = {
                        "size": self._pool.get_stats().get("pool_size", 0),
                        "available": self._pool.get_stats().get("pool_available", 0),
                    }
                    
                    # Get table counts
                    try:
                        cursor = await conn.execute(
                            """
                            SELECT 
                                (SELECT COUNT(*) FROM chats) as chats,
                                (SELECT COUNT(*) FROM messages) as messages,
                                (SELECT COUNT(*) FROM artifacts) as artifacts
                            """
                        )
                        counts = await cursor.fetchone()
                        result["counts"] = counts
                    except Exception:
                        # Tables might not exist yet
                        pass
                    
        except Exception as e:
            result["error"] = str(e)
            logger.error(f"Health check failed: {e}")
        
        return result
    
    async def get_diagnostics(self) -> Dict[str, Any]:
        """
        Get detailed diagnostics information.
        
        Returns:
            Dict with connection pool and database statistics
        """
        diagnostics = {
            "connected": self._connected,
            "schema_initialized": self._schema_initialized,
            "pool_config": {
                "min_size": self.min_size,
                "max_size": self.max_size,
                "max_idle": self.max_idle,
                "timeout": self.timeout,
            },
        }
        
        if self._pool:
            try:
                stats = self._pool.get_stats()
                diagnostics["pool_stats"] = stats
            except Exception as e:
                diagnostics["pool_error"] = str(e)
        
        return diagnostics
    
    # =========================================================================
    # UTILITY METHODS
    # =========================================================================
    
    def is_connected(self) -> bool:
        """Check if database is connected."""
        return self._connected and self._pool is not None
    
    def is_schema_initialized(self) -> bool:
        """Check if schema has been initialized."""
        return self._schema_initialized
    
    async def execute(self, query: str, params: tuple = None) -> Any:
        """
        Execute a query and return cursor (convenience method).
        
        Args:
            query: SQL query string
            params: Query parameters
            
        Returns:
            Cursor with query results
        """
        async with self.get_connection() as conn:
            if params:
                return await conn.execute(query, params)
            else:
                return await conn.execute(query)
    
    async def fetch_one(self, query: str, params: tuple = None) -> Optional[Dict[str, Any]]:
        """
        Execute query and fetch one result (convenience method).
        
        Args:
            query: SQL query string
            params: Query parameters
            
        Returns:
            Single row as dict, or None
        """
        cursor = await self.execute(query, params)
        return await cursor.fetchone()
    
    async def fetch_all(self, query: str, params: tuple = None) -> list[Dict[str, Any]]:
        """
        Execute query and fetch all results (convenience method).
        
        Args:
            query: SQL query string
            params: Query parameters
            
        Returns:
            List of rows as dicts
        """
        cursor = await self.execute(query, params)
        return await cursor.fetchall()

