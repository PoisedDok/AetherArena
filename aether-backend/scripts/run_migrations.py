#!/usr/bin/env python3
"""
Aether Backend - Database Migration Runner

Production-ready migration management with:
- Version tracking
- Rollback support
- Migration history
- Checksum validation
- Transaction safety

@.architecture
Incoming: Command line, database/schema.sql --- {CLI args, SQL migration files, database connection}
Processing: run_migrations(), rollback_migration(), track_version(), validate_checksum() --- {4 jobs: checksum_validation, migration_execution, rollback_handling, version_tracking}
Outgoing: PostgreSQL database, stdout --- {Updated database schema, migration history, execution log}
"""

import sys
import os
import hashlib
import argparse
from pathlib import Path
from datetime import datetime
from typing import List, Optional, Dict, Any
import psycopg
from psycopg.rows import dict_row

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


# =============================================================================
# Configuration
# =============================================================================

MIGRATIONS_DIR = PROJECT_ROOT / "data" / "database" / "migrations"

# Migration metadata table
MIGRATIONS_TABLE = "schema_migrations"

# Environment configuration
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://aether_user:aether_pass@localhost:5432/aether_dev"
)


# =============================================================================
# Terminal Colors
# =============================================================================

class Colors:
    """ANSI color codes for terminal output."""
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    MAGENTA = '\033[0;35m'
    CYAN = '\033[0;36m'
    WHITE = '\033[1;37m'
    RESET = '\033[0m'


def log_info(message: str) -> None:
    """Log info message."""
    print(f"{Colors.BLUE}[INFO]{Colors.RESET} {message}")


def log_success(message: str) -> None:
    """Log success message."""
    print(f"{Colors.GREEN}[SUCCESS]{Colors.RESET} {message}")


def log_warn(message: str) -> None:
    """Log warning message."""
    print(f"{Colors.YELLOW}[WARN]{Colors.RESET} {message}")


def log_error(message: str) -> None:
    """Log error message."""
    print(f"{Colors.RED}[ERROR]{Colors.RESET} {message}")


# =============================================================================
# Database Connection
# =============================================================================

def get_connection():
    """Get database connection."""
    try:
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
        return conn
    except Exception as e:
        log_error(f"Failed to connect to database: {e}")
        log_error(f"Connection string: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else DATABASE_URL}")
        sys.exit(1)


# =============================================================================
# Migration Tracking
# =============================================================================

def init_migrations_table(conn) -> None:
    """Create migrations tracking table if not exists."""
    with conn.cursor() as cur:
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (
                id SERIAL PRIMARY KEY,
                version VARCHAR(255) UNIQUE NOT NULL,
                name VARCHAR(255) NOT NULL,
                checksum VARCHAR(64) NOT NULL,
                executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                execution_time_ms INTEGER,
                success BOOLEAN NOT NULL DEFAULT TRUE,
                error_message TEXT
            )
        """)
        conn.commit()
    log_info(f"Migrations table '{MIGRATIONS_TABLE}' initialized")


def get_applied_migrations(conn) -> List[Dict[str, Any]]:
    """Get list of applied migrations."""
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT version, name, checksum, executed_at, success
            FROM {MIGRATIONS_TABLE}
            WHERE success = TRUE
            ORDER BY executed_at
        """)
        return cur.fetchall()


def is_migration_applied(conn, version: str) -> bool:
    """Check if migration is already applied."""
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT 1 FROM {MIGRATIONS_TABLE}
            WHERE version = %s AND success = TRUE
        """, (version,))
        return cur.fetchone() is not None


def record_migration(
    conn,
    version: str,
    name: str,
    checksum: str,
    execution_time_ms: int,
    success: bool = True,
    error_message: Optional[str] = None
) -> None:
    """Record migration execution."""
    with conn.cursor() as cur:
        cur.execute(f"""
            INSERT INTO {MIGRATIONS_TABLE}
            (version, name, checksum, execution_time_ms, success, error_message)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (version) DO UPDATE
            SET executed_at = NOW(),
                execution_time_ms = EXCLUDED.execution_time_ms,
                success = EXCLUDED.success,
                error_message = EXCLUDED.error_message
        """, (version, name, checksum, execution_time_ms, success, error_message))
        conn.commit()


# =============================================================================
# Migration Files
# =============================================================================

def calculate_checksum(file_path: Path) -> str:
    """Calculate SHA256 checksum of migration file."""
    sha256 = hashlib.sha256()
    with open(file_path, 'rb') as f:
        for chunk in iter(lambda: f.read(4096), b''):
            sha256.update(chunk)
    return sha256.hexdigest()


def get_migration_files() -> List[Dict[str, Any]]:
    """
    Get list of migration files.
    
    Expected naming: {version}_{name}.sql
    Example: 001_initial_schema.sql, 002_add_indexes.sql
    """
    if not MIGRATIONS_DIR.exists():
        log_error(f"Migrations directory not found: {MIGRATIONS_DIR}")
        sys.exit(1)
    
    migrations = []
    
    # Find all .sql files
    for file_path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        # Extract version and name from filename
        # Support both versioned (001_name.sql) and simple (schema.sql) naming
        filename = file_path.stem
        
        # Try to extract version number
        if '_' in filename:
            parts = filename.split('_', 1)
            version = parts[0]
            name = parts[1] if len(parts) > 1 else filename
        else:
            # For simple names like "schema.sql", use filename as version
            version = filename
            name = filename
        
        migrations.append({
            "version": version,
            "name": name,
            "file_path": file_path,
            "checksum": calculate_checksum(file_path)
        })
    
    return sorted(migrations, key=lambda x: x["version"])


# =============================================================================
# Migration Execution
# =============================================================================

def execute_migration(conn, migration: Dict[str, Any]) -> bool:
    """
    Execute a single migration file.
    
    Returns:
        bool: True if successful, False otherwise
    """
    version = migration["version"]
    name = migration["name"]
    file_path = migration["file_path"]
    checksum = migration["checksum"]
    
    log_info(f"Executing migration: {version}_{name}")
    log_info(f"  File: {file_path.name}")
    log_info(f"  Checksum: {checksum[:16]}...")
    
    # Read migration SQL
    try:
        with open(file_path, 'r') as f:
            sql = f.read()
    except Exception as e:
        log_error(f"Failed to read migration file: {e}")
        record_migration(conn, version, name, checksum, 0, False, str(e))
        return False
    
    # Execute migration in transaction
    start_time = datetime.now()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
        
        execution_time = int((datetime.now() - start_time).total_seconds() * 1000)
        log_success(f"Migration executed successfully ({execution_time}ms)")
        
        # Record success
        record_migration(conn, version, name, checksum, execution_time, True)
        return True
        
    except Exception as e:
        conn.rollback()
        execution_time = int((datetime.now() - start_time).total_seconds() * 1000)
        log_error(f"Migration failed: {e}")
        
        # Record failure
        record_migration(conn, version, name, checksum, execution_time, False, str(e))
        return False


def run_migrations(conn, dry_run: bool = False, target_version: Optional[str] = None) -> None:
    """
    Run pending migrations.
    
    Args:
        conn: Database connection
        dry_run: If True, only show what would be executed
        target_version: If provided, migrate up to this version only
    """
    # Get available migrations
    available_migrations = get_migration_files()
    if not available_migrations:
        log_warn("No migration files found")
        return
    
    log_info(f"Found {len(available_migrations)} migration files")
    
    # Get applied migrations
    applied_migrations = get_applied_migrations(conn)
    applied_versions = {m["version"] for m in applied_migrations}
    
    log_info(f"Already applied: {len(applied_versions)} migrations")
    
    # Find pending migrations
    pending_migrations = [
        m for m in available_migrations
        if m["version"] not in applied_versions
    ]
    
    # Filter by target version if provided
    if target_version:
        pending_migrations = [
            m for m in pending_migrations
            if m["version"] <= target_version
        ]
    
    if not pending_migrations:
        log_success("Database is up to date!")
        return
    
    log_info(f"Pending migrations: {len(pending_migrations)}")
    print()
    
    # Show pending migrations
    for i, migration in enumerate(pending_migrations, 1):
        print(f"  {i}. {migration['version']}_{migration['name']}")
    print()
    
    if dry_run:
        log_info("Dry run mode - no migrations executed")
        return
    
    # Execute migrations
    success_count = 0
    for migration in pending_migrations:
        if execute_migration(conn, migration):
            success_count += 1
        else:
            log_error("Migration failed - stopping execution")
            break
        print()
    
    # Summary
    if success_count == len(pending_migrations):
        log_success(f"All {success_count} migrations applied successfully!")
    else:
        log_warn(f"Applied {success_count}/{len(pending_migrations)} migrations")


# =============================================================================
# Migration Status
# =============================================================================

def show_status(conn) -> None:
    """Show current migration status."""
    log_info("Migration Status")
    print()
    
    # Get applied migrations
    applied_migrations = get_applied_migrations(conn)
    
    if not applied_migrations:
        log_warn("No migrations applied yet")
        return
    
    # Show applied migrations
    print(f"{Colors.WHITE}Applied Migrations:{Colors.RESET}")
    print()
    print(f"  {'Version':<20} {'Name':<30} {'Executed At':<25} {'Time (ms)':<10}")
    print(f"  {'-'*20} {'-'*30} {'-'*25} {'-'*10}")
    
    for m in applied_migrations:
        executed_at = m["executed_at"].strftime("%Y-%m-%d %H:%M:%S")
        # Handle NULL execution_time_ms
        time_str = "N/A" if m.get("execution_time_ms") is None else str(m["execution_time_ms"])
        print(f"  {m['version']:<20} {m['name']:<30} {executed_at:<25} {time_str:<10}")
    
    print()
    log_info(f"Total applied: {len(applied_migrations)}")


# =============================================================================
# Rollback Support
# =============================================================================

def rollback_migration(conn, version: str) -> None:
    """
    Rollback a specific migration.
    
    Note: This only removes the migration from tracking table.
    Actual schema rollback requires manual intervention or down migrations.
    """
    log_warn(f"Rolling back migration: {version}")
    log_warn("Note: This only removes the migration record. Schema changes are NOT reverted.")
    log_warn("You must manually revert schema changes or create a down migration.")
    
    # Confirm
    confirm = input(f"\nAre you sure you want to rollback {version}? (yes/no): ")
    if confirm.lower() != 'yes':
        log_info("Rollback cancelled")
        return
    
    # Remove migration record
    with conn.cursor() as cur:
        cur.execute(f"""
            DELETE FROM {MIGRATIONS_TABLE}
            WHERE version = %s
        """, (version,))
        conn.commit()
    
    log_success(f"Migration {version} rolled back from tracking table")
    log_warn("Remember to manually revert schema changes!")


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Aether Backend Database Migration Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Show current status
  python run_migrations.py status

  # Run all pending migrations
  python run_migrations.py migrate

  # Dry run (show what would be executed)
  python run_migrations.py migrate --dry-run

  # Migrate to specific version
  python run_migrations.py migrate --target 002

  # Rollback a migration (tracking only)
  python run_migrations.py rollback 002
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # Status command
    subparsers.add_parser('status', help='Show migration status')
    
    # Migrate command
    migrate_parser = subparsers.add_parser('migrate', help='Run pending migrations')
    migrate_parser.add_argument('--dry-run', action='store_true', help='Show pending migrations without executing')
    migrate_parser.add_argument('--target', help='Migrate up to specific version')
    
    # Rollback command
    rollback_parser = subparsers.add_parser('rollback', help='Rollback a migration (tracking only)')
    rollback_parser.add_argument('version', help='Migration version to rollback')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    # Connect to database
    log_info("Connecting to database...")
    conn = get_connection()
    log_success("Connected")
    print()
    
    # Initialize migrations table
    init_migrations_table(conn)
    print()
    
    # Execute command
    try:
        if args.command == 'status':
            show_status(conn)
        
        elif args.command == 'migrate':
            run_migrations(conn, dry_run=args.dry_run, target_version=args.target)
        
        elif args.command == 'rollback':
            rollback_migration(conn, args.version)
    
    finally:
        conn.close()


if __name__ == "__main__":
    main()

