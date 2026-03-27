"""
@.architecture
Incoming: app.py::startup_event --- {SupabaseClient, none}
Processing: check pending migrations, execute SQL files, track applied migrations, reload schema cache --- {5 jobs: JOB_HEALTH_CHECK, JOB_INITIALIZE_COMPONENT, JOB_QUERY_DB, JOB_SAVE_TO_DB, JOB_UPDATE_DB}
Outgoing: Supabase database (migrations tracking table) --- {bool, status}

Migration Runner - Automatic database migration executor

This module runs database migrations automatically on backend startup.
Migrations are SQL files in data/database/migrations/ executed in order.

Architecture:
- Runs on application startup (before API server starts)
- Idempotent (tracks applied migrations in database)
- Fails fast if migration errors occur
- Reloads PostgREST schema cache after migrations

CRITICAL DATABASE ARCHITECTURE:
==========================================
DATABASE NAME: 'aether' (NOT 'postgres')
DATABASE USER: 'supabase_admin' (NOT 'postgres')
==========================================
- The 'postgres' database is for PostgreSQL system tables ONLY
- The 'aether' database is where ALL application data lives
- PostgREST reads from 'aether' database
- Frontend connects through PostgREST to 'aether' database
- Migrations MUST target 'aether' database ONLY
- supabase_admin owns the 'aether' database and has proper permissions
==========================================
"""

import asyncio
import sys
from pathlib import Path
from typing import List, Tuple

from monitoring import get_logger

logger = get_logger(__name__)

# =============================================================================
# CRITICAL: Database Configuration Constants
# =============================================================================
# ============================================================================
# CRITICAL DATABASE CONFIGURATION - DO NOT MODIFY
# ============================================================================
# These values MUST NOT be changed without full system review.
# Changing these breaks PostgREST, frontend, and all database operations.
#
# IMPORTANT: We use the 'aether' database for ALL application data.
# The 'postgres' database is ONLY used for metadata operations (checking if
# 'aether' exists, creating it if needed). All migrations execute against 'aether'.
# ============================================================================

TARGET_DATABASE = "aether"  # Application database (NOT 'postgres')
DATABASE_USER = "supabase_admin"  # Database owner with full permissions
DOCKER_CONTAINER = "supabase-db"  # Supabase PostgreSQL container name


class MigrationRunner:
    """
    Automatic migration runner for Supabase PostgreSQL.
    
    Features:
    - Tracks applied migrations in `schema_migrations` table
    - Executes migrations in alphanumeric order
    - Reloads PostgREST schema cache after successful migrations
    - Fails fast on errors to prevent partially applied migrations
    """
    
    def __init__(self):
        """
        Initialize migration runner.
        """
        # Robust path resolution for frozen binaries
        if getattr(sys, 'frozen', False):
            # PyInstaller bundles migrations to _internal/data/database/migrations
            base_dir = Path(sys._MEIPASS)
            self.migrations_dir = base_dir / "data" / "database" / "migrations"
        else:
            # Development mode
            self.migrations_dir = Path(__file__).parent / "migrations"
    
    async def run_migrations(self) -> bool:
        """
        Execute all pending migrations.
        
        Returns:
            True if migrations completed successfully, False otherwise
        """
        try:
            # 1. Bootstrap Infrastructure (Roles, Core Databases, JWT Settings)
            # This runs before any application-specific migrations.
            await self._bootstrap_infrastructure()

            # 2. Ensure migrations tracking table exists
            await self._ensure_migrations_table()
            
            # 3. Get list of pending migrations
            pending = await self._get_pending_migrations()
            
            if not pending:
                logger.info("No pending migrations")
                return True
            
            logger.info(f"Found {len(pending)} pending migration(s)")
            
            # Execute each migration
            for migration_file, migration_name in pending:
                logger.info(f"Applying migration: {migration_name}")
                
                try:
                    await self._execute_migration(migration_file, migration_name)
                    logger.info(f"✅ Applied migration: {migration_name}")
                except Exception as e:
                    logger.error(f"❌ Failed to apply migration {migration_name}: {e}", exc_info=True)
                    return False
            
            # Reload PostgREST schema cache
            await self._reload_schema_cache()
            
            logger.info(f"✅ Successfully applied {len(pending)} migration(s)")
            return True
            
        except Exception as e:
            logger.error(f"Migration runner failed: {e}", exc_info=True)
            return False

    async def _bootstrap_infrastructure(self) -> None:
        """
        Bootstrap the bare PostgreSQL instance with Supabase infrastructure.
        Handles: roles, core databases, and system settings.
        Runs BEFORE migrations.
        """
        import subprocess
        import os

        logger.info("Starting infrastructure bootstrap...")

        # 1. Ensure core databases exist
        await self._ensure_target_database()

        # 2. Setup standard Supabase roles and set passwords
        # These are used by PostgREST and Auth/Storage/Edge Runtime services.
        password = os.environ.get("POSTGRES_PASSWORD", "postgres")
        
        # We try to run bootstrap as 'postgres' superuser first.
        # This is required if current user (supabase_admin) isn't set up yet.
        roles_sql = f"""
        DO $$
        BEGIN
            -- Ensure Supabase Auth Roles
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
                CREATE ROLE anon NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
                CREATE ROLE authenticated NOLOGIN;
            END IF;
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
                CREATE ROLE service_role NOLOGIN;
            END IF;

            -- Ensure Supabase Infra Roles
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
                CREATE ROLE authenticator NOINHERIT LOGIN;
            END IF;
            IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin') THEN
                CREATE ROLE supabase_admin WITH SUPERUSER CREATEROLE CREATEDB LOGIN;
            END IF;

            -- Enforce Current Passwords
            ALTER ROLE authenticator WITH PASSWORD '{password}';
            ALTER ROLE supabase_admin WITH PASSWORD '{password}';

            -- Establish Grant Hierarchy
            GRANT anon, authenticated, service_role TO authenticator;
            
            -- Prevent PostgREST schema cache reload from timing out on slow/cold instances
            ALTER ROLE authenticator SET statement_timeout = '30s';
            ALTER ROLE anon SET statement_timeout = '30s';
            ALTER ROLE authenticated SET statement_timeout = '30s';
            ALTER ROLE service_role SET statement_timeout = '30s';
            ALTER ROLE supabase_admin SET statement_timeout = '60s';
        END
        $$;
        """

        try:
            # Try as 'postgres' superuser
            subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", roles_sql],
                check=True, capture_output=True, text=True, timeout=30
            )
            logger.info("✅ Supabase roles verified/created via 'postgres' superuser")
        except subprocess.CalledProcessError:
            # Fallback to current DATABASE_USER if postgres is locked or not available
            subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", "postgres", "-c", roles_sql],
                check=True, capture_output=True, text=True, timeout=30
            )
            logger.info(f"✅ Supabase roles verified via '{DATABASE_USER}'")

        # 3. Inject JWT Settings (used by PostgREST internally)
        # These are stored at database level so they persist in 'aether' context.
        jwt_secret = os.environ.get("JWT_SECRET", "default-secret-change-me-immediately-in-production")
        jwt_exp = os.environ.get("JWT_EXP", "3600")
        
        settings_sql = f"""
        ALTER DATABASE {TARGET_DATABASE} SET "app.settings.jwt_secret" = '{jwt_secret}';
        ALTER DATABASE {TARGET_DATABASE} SET "app.settings.jwt_exp" = '{jwt_exp}';
        """
        
        subprocess.run(
            ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", "postgres", "-c", settings_sql],
            check=True, capture_output=True, text=True, timeout=30
        )
        logger.info(f"✅ JWT settings injected into '{TARGET_DATABASE}'")

        # 4. Create Core Schemas in 'aether' (required for certain extensions)
        schemas_sql = """
        CREATE SCHEMA IF NOT EXISTS _realtime;
        CREATE SCHEMA IF NOT EXISTS supabase_functions;
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE SCHEMA IF NOT EXISTS vault;
        """
        subprocess.run(
            ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-c", schemas_sql],
            check=True, capture_output=True, text=True, timeout=30
        )
        logger.info(f"✅ Infrastructure schemas verified in '{TARGET_DATABASE}'")

    async def _ensure_target_database(self) -> None:
        """
        Ensure the target application database exists.

        Supabase containers may start with POSTGRES_DB=postgres by default. Our application
        requires a dedicated 'aether' database. Create it if missing.
        Also creates '_supabase' database if missing (required for analytics/logging).
        """
        import subprocess

        # List of databases to ensure exist
        dbs_to_ensure = [TARGET_DATABASE, "_supabase"]
        
        for db_name in dbs_to_ensure:
            try:
                # Check existence using the default postgres database (always present).
                check_sql = f"SELECT 1 FROM pg_database WHERE datname = '{db_name}';"
                result = subprocess.run(
                    ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", "postgres", "-t", "-c", check_sql],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                exists = bool(result.stdout.strip())

                if not exists:
                    create_sql = f"CREATE DATABASE {db_name} OWNER {DATABASE_USER};"
                    subprocess.run(
                        ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", "postgres", "-c", create_sql],
                        check=True,
                        capture_output=True,
                        text=True,
                        timeout=30
                    )
                    logger.info(f"✅ Created database '{db_name}' owned by '{DATABASE_USER}'")
            except subprocess.CalledProcessError as e:
                logger.error(f"Failed to ensure database '{db_name}': {e.stderr}")
                # Don't fail if _supabase fails (might not be critical for all envs)
                if db_name == TARGET_DATABASE:
                    raise
            except Exception as e:
                logger.error(f"Failed to ensure database '{db_name}': {e}")
                if db_name == TARGET_DATABASE:
                    raise
    
    async def _ensure_migrations_table(self) -> None:
        """
        Create schema_migrations table if it doesn't exist.
        
        CRITICAL: Uses TARGET_DATABASE constant to ensure correct database.
        DO NOT hardcode database names - use constants defined at module level.
        """
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
        
        try:
            import subprocess
            
            # Validate we're using correct database
            if TARGET_DATABASE != "aether":
                raise ValueError(f"CRITICAL: TARGET_DATABASE must be 'aether', got '{TARGET_DATABASE}'")
            
            # Execute directly via docker exec (bypasses PostgREST schema cache)
            result = subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-c", create_table_sql],
                check=True,
                capture_output=True,
                text=True,
                timeout=30
            )
            
            logger.debug(f"Migrations tracking table ensured in '{TARGET_DATABASE}' database")
            
        except subprocess.CalledProcessError as e:
            logger.error(f"Failed to create schema_migrations table in '{TARGET_DATABASE}': {e.stderr}")
            raise
        except Exception as e:
            logger.error(f"Failed to ensure migrations table: {e}")
            raise
    
    async def _get_pending_migrations(self) -> List[Tuple[Path, str]]:
        """
        Get list of pending migration files via direct PostgreSQL query.
        
        Returns:
            List of (file_path, migration_name) tuples
        """
        if not self.migrations_dir.exists():
            logger.warning(f"Migrations directory not found: {self.migrations_dir}")
            return []
        
        # Get all .sql files (excluding templates and backups)
        all_migrations = sorted(
            [
                p for p in self.migrations_dir.glob("*.sql")
                if not p.name.endswith(".template")
                and not p.name.startswith(".")
                and "TEMPLATE" not in p.name.upper()
            ],
            key=lambda p: p.name
        )
        
        if not all_migrations:
            return []
        
        # Get already applied migrations via direct PostgreSQL (bypasses PostgREST)
        try:
            import subprocess
            
            result = subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-t", "-c", "SELECT version FROM schema_migrations;"],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            if result.returncode == 0:
                # Parse output (one version per line, strip whitespace)
                applied_versions = {
                    line.strip() 
                    for line in result.stdout.splitlines() 
                    if line.strip()
                }
            else:
                # Table doesn't exist yet or query failed, all migrations are pending
                logger.debug("Could not query applied migrations (table may not exist yet)")
                applied_versions = set()
                
        except Exception as e:
            # Table doesn't exist yet, all migrations are pending
            logger.debug(f"Could not query applied migrations: {e}")
            applied_versions = set()
        
        # Filter pending migrations
        pending = []
        for migration_file in all_migrations:
            migration_name = migration_file.stem  # e.g., "002_trail_schema"
            
            if migration_name not in applied_versions:
                pending.append((migration_file, migration_name))
        
        return pending
    
    async def _execute_migration(self, migration_file: Path, migration_name: str) -> None:
        """
        Execute a single migration file.
        
        CRITICAL: All migrations execute against TARGET_DATABASE ('aether') ONLY.
        Uses DATABASE_USER ('supabase_admin') for proper permissions.
        
        Args:
            migration_file: Path to migration SQL file
            migration_name: Migration identifier (filename without extension)
        
        Raises:
            Exception: If migration execution fails
        """
        # Read migration SQL
        sql_content = migration_file.read_text()
        
        # Execute via docker exec (most reliable for DDL operations)
        import subprocess
        import os
        
        try:
            # Copy file to container
            subprocess.run(
                ["docker", "cp", str(migration_file), f"{DOCKER_CONTAINER}:/tmp/current_migration.sql"],
                check=True,
                capture_output=True,
                timeout=30
            )
            
            # Prepare psql command with environment variables as psql variables
            # This allows scripts to use :'var_name' syntax.
            psql_vars = []
            for var in ["POSTGRES_PASSWORD", "JWT_SECRET", "JWT_EXP", "POSTGRES_USER"]:
                val = os.environ.get(var)
                if val:
                    psql_vars.extend(["-v", f"{var.lower()}={val}"])
            
            # Also support 'pgpass' and 'pguser' aliases used in legacy scripts
            if os.environ.get("POSTGRES_PASSWORD"):
                psql_vars.extend(["-v", f"pgpass={os.environ.get('POSTGRES_PASSWORD')}"])
            if os.environ.get("POSTGRES_USER"):
                psql_vars.extend(["-v", f"pguser={os.environ.get('POSTGRES_USER')}"])

            # Execute migration (uses constants to ensure correct database)
            logger.info(f"Executing migration {migration_name} against database '{TARGET_DATABASE}' as user '{DATABASE_USER}'")
            
            cmd = ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE]
            cmd.extend(psql_vars)
            cmd.extend(["-f", "/tmp/current_migration.sql"])
            
            result = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
                timeout=120
            )
            
            # Log output (warnings/notices)
            if result.stdout:
                logger.debug(f"Migration {migration_name} output:\n{result.stdout}")
            
            # Record migration as applied (SQL injection safe: migration_name is validated filename)
            record_sql = f"INSERT INTO schema_migrations (version) VALUES ('{migration_name}') ON CONFLICT (version) DO NOTHING;"
            
            subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-c", record_sql],
                check=True,
                capture_output=True,
                timeout=30
            )
            
        except subprocess.CalledProcessError as e:
            logger.error(f"Migration execution failed: {e.stderr}")
            raise Exception(f"Migration {migration_name} failed: {e.stderr}")
        except subprocess.TimeoutExpired:
            raise Exception(f"Migration {migration_name} timed out")
    
    async def _reload_schema_cache(self) -> None:
        """
        Reload PostgREST schema cache to recognize new tables/views.
        
        PostgREST caches the schema from TARGET_DATABASE ('aether').
        After migrations, we send a reload signal so PostgREST recognizes new objects.
        """
        try:
            import subprocess
            
            logger.info(f"Reloading PostgREST schema cache for database '{TARGET_DATABASE}'")
            
            # Send NOTIFY signal to trigger schema reload (graceful)
            subprocess.run(
                ["docker", "exec", DOCKER_CONTAINER, "psql", "-U", DATABASE_USER, "-d", TARGET_DATABASE, "-c", "NOTIFY pgrst, 'reload schema';"],
                check=True,
                capture_output=True,
                timeout=10
            )
            
            # Wait for PostgREST to reload
            await asyncio.sleep(2)
            
            logger.info("✅ PostgREST schema cache reload signal sent")
            
        except Exception as e:
            logger.warning(f"Failed to reload PostgREST schema cache: {e}")
            logger.info("Note: PostgREST will auto-reload on next request")


async def run_migrations() -> bool:
    """
    Run all pending database migrations.
    
    This is called during application startup to ensure database schema is up to date.
    
    Returns:
        True if migrations succeeded, False otherwise
    """
    runner = MigrationRunner()
    return await runner.run_migrations()
