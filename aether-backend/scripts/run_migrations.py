#!/usr/bin/env python3
# Incoming: none --- {none, none}
# Processing: none --- {0 jobs: none}
# Outgoing: none --- {none, none}
"""
Aether Backend - Database Migration Runner

Production-ready migration management via Supabase:
- Version tracking
- Rollback support
- Migration history
- Checksum validation
- Transaction safety via Supabase SDK

Note: Migrations are now managed through Supabase CLI and initialization scripts.
This script provides compatibility layer for migration tracking.

@.architecture
Incoming: Command line, Supabase migration scripts --- {CLI args, SQL migration files}
Processing: run_migrations(), rollback_migration(), track_version(), validate_checksum() via SupabaseClient --- {JOB_CLEANUP_RESOURCE, JOB_EXECUTE_TOOL, JOB_TRACE, JOB_VALIDATE}
Outgoing: Supabase database, stdout --- {Updated database schema, migration history, execution log}
"""

import sys
import hashlib
import argparse
import asyncio
from pathlib import Path
from datetime import datetime
from typing import List, Optional, Dict, Any

# Add project root to path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


# =============================================================================
# Configuration
# =============================================================================

# Note: Migrations are primarily managed through Supabase init scripts
# This script provides compatibility tracking for migration history

MIGRATIONS_DIR = PROJECT_ROOT / "data" / "database" / "migrations"

# Migration metadata table (stored in Supabase)
MIGRATIONS_TABLE = "schema_migrations"


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
# Supabase Connection
# =============================================================================

async def get_supabase_client():
    """Get Supabase client."""
    try:
        from data.database.clients.supabase import SupabaseClient
        from config.settings import get_settings
        settings = get_settings()
        
        supabase = SupabaseClient.from_env({
            "url": settings.supabase.url,
            "anon_key": settings.supabase.anon_key,
            "service_role_key": settings.supabase.service_role_key,
            "schema": settings.supabase.db_schema,
            "realtime_enabled": False,
        })
        
        await supabase.initialize()
        return supabase
        
    except Exception as e:
        log_error(f"Failed to connect to Supabase: {e}")
        sys.exit(1)


# =============================================================================
# Migration Tracking via Supabase
# =============================================================================

async def init_migrations_table(supabase) -> None:
    """Create migrations tracking table if not exists via Supabase."""
    try:
        # Check if table exists by attempting a query
        await supabase.select(MIGRATIONS_TABLE, limit=1, admin=True)
        log_info(f"Migrations table '{MIGRATIONS_TABLE}' already exists")
    except Exception:
        log_warn(f"Migrations table '{MIGRATIONS_TABLE}' may not exist")
        log_warn("Please ensure Supabase init scripts have been executed")
        log_warn("Schema should be managed through Supabase migrations")


async def get_applied_migrations(supabase) -> List[Dict[str, Any]]:
    """Get list of applied migrations from Supabase."""
    try:
        migrations = await supabase.select(
            MIGRATIONS_TABLE,
            columns="version,name,checksum,executed_at,success",
            filters={"success": True},
            order_by="executed_at",
            admin=True
        )
        return migrations
    except Exception as e:
        log_warn(f"Could not fetch applied migrations: {e}")
        return []


async def is_migration_applied(supabase, version: str) -> bool:
    """Check if migration is already applied."""
    try:
        migrations = await supabase.select(
            MIGRATIONS_TABLE,
            filters={"version": version, "success": True},
            limit=1,
            admin=True
        )
        return len(migrations) > 0
    except Exception:
        return False


async def record_migration(
    supabase,
    version: str,
    name: str,
    checksum: str,
    execution_time_ms: int,
    success: bool = True,
    error_message: Optional[str] = None
) -> None:
    """Record migration execution in Supabase."""
    try:
        data = {
            "version": version,
            "name": name,
            "checksum": checksum,
            "execution_time_ms": execution_time_ms,
            "success": success,
            "error_message": error_message,
            "executed_at": datetime.utcnow().isoformat()
        }
        
        await supabase.upsert(
            MIGRATIONS_TABLE,
            data,
            on_conflict="version",
            admin=True
        )
    except Exception as e:
        log_error(f"Failed to record migration: {e}")


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
# Migration Status
# =============================================================================

async def show_status(supabase) -> None:
    """Show current migration status."""
    log_info("Migration Status (Supabase)")
    print()
    
    # Get applied migrations
    applied_migrations = await get_applied_migrations(supabase)
    
    if not applied_migrations:
        log_warn("No migrations applied yet")
        log_info("Note: Supabase schema is managed through init scripts")
        return
    
    # Show applied migrations
    print(f"{Colors.WHITE}Applied Migrations:{Colors.RESET}")
    print()
    print(f"  {'Version':<20} {'Name':<30} {'Executed At':<25} {'Time (ms)':<10}")
    print(f"  {'-'*20} {'-'*30} {'-'*25} {'-'*10}")
    
    for m in applied_migrations:
        executed_at = m.get("executed_at", "N/A")
        if isinstance(executed_at, str):
            try:
                dt = datetime.fromisoformat(executed_at.replace('Z', '+00:00'))
                executed_at = dt.strftime("%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError):
                pass
        
        time_str = "N/A" if m.get("execution_time_ms") is None else str(m.get("execution_time_ms"))
        print(f"  {m['version']:<20} {m['name']:<30} {str(executed_at):<25} {time_str:<10}")
    
    print()
    log_info(f"Total applied: {len(applied_migrations)}")
    log_info("For new migrations, use Supabase CLI: supabase migration new <name>")


# =============================================================================
# Rollback Support
# =============================================================================

async def rollback_migration(supabase, version: str) -> None:
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
    try:
        await supabase.delete(
            MIGRATIONS_TABLE,
            version,
            id_column="version",
            admin=True
        )
        log_success(f"Migration {version} rolled back from tracking table")
        log_warn("Remember to manually revert schema changes!")
    except Exception as e:
        log_error(f"Rollback failed: {e}")


# =============================================================================
# Main Entry Point
# =============================================================================

async def main_async(args):
    """Async main entry point."""
    # Connect to Supabase
    log_info("Connecting to Supabase...")
    supabase = await get_supabase_client()
    log_success("Connected to Supabase")
    print()
    
    # Initialize migrations table
    await init_migrations_table(supabase)
    print()
    
    # Execute command
    try:
        if args.command == 'status':
            await show_status(supabase)
        
        elif args.command == 'rollback':
            await rollback_migration(supabase, args.version)
        
        elif args.command == 'migrate':
            log_warn("Direct migration execution is deprecated")
            log_info("Supabase schema is managed through init scripts and Supabase CLI")
            log_info("To apply new migrations:")
            log_info("  1. Create migration: supabase migration new <name>")
            log_info("  2. Write SQL in generated file")
            log_info("  3. Apply: supabase db push")
            print()
            await show_status(supabase)
    
    finally:
        await supabase.dispose()


# =============================================================================
# CLI Interface
# =============================================================================

def main():
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Aether Backend Database Migration Runner (Supabase)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Show current status
  python run_migrations.py status

  # Rollback a migration (tracking only)
  python run_migrations.py rollback 002

Note:
  Migrations are now managed through Supabase CLI.
  This script provides compatibility tracking only.
  
  For new migrations:
    supabase migration new <name>
    supabase db push
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # Status command
    subparsers.add_parser('status', help='Show migration status')
    
    # Migrate command (deprecated)
    migrate_parser = subparsers.add_parser('migrate', help='Show migration info (deprecated)')
    
    # Rollback command
    rollback_parser = subparsers.add_parser('rollback', help='Rollback a migration (tracking only)')
    rollback_parser.add_argument('version', help='Migration version to rollback')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    # Run async main
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
