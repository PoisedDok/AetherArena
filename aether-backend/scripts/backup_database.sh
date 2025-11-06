#!/bin/bash
# =============================================================================
# Aether Backend - Database Backup Script
# =============================================================================
# Production-ready PostgreSQL backup with:
# - Compressed backups (gzip)
# - Timestamped backup files
# - Automatic retention policy
# - Backup verification
# - Restore functionality
# - Scheduled backup support
# =============================================================================

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'  # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# =============================================================================
# Configuration
# =============================================================================

# PostgreSQL connection settings
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-aether_user}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-aether_pass}"
POSTGRES_DB="${POSTGRES_DB:-aether_dev}"

# Backup settings
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"  # Keep backups for 7 days
MAX_BACKUPS="${MAX_BACKUPS:-10}"  # Keep maximum 10 backups

# Timestamp for backup file
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/aether_backup_${TIMESTAMP}.sql.gz"

# =============================================================================
# Argument Parsing
# =============================================================================

COMMAND="${1:-backup}"

show_usage() {
    cat << EOF
Aether Backend Database Backup Tool

Usage: $0 <command> [options]

Commands:
  backup              Create a new database backup (default)
  restore <file>      Restore from a backup file
  list                List available backups
  cleanup             Remove old backups based on retention policy
  help                Show this help message

Environment Variables:
  POSTGRES_HOST       PostgreSQL host (default: localhost)
  POSTGRES_PORT       PostgreSQL port (default: 5432)
  POSTGRES_USER       PostgreSQL user (default: aether_user)
  POSTGRES_PASSWORD   PostgreSQL password (default: aether_pass)
  POSTGRES_DB         Database name (default: aether_dev)
  BACKUP_DIR          Backup directory (default: <project>/backups)
  BACKUP_RETENTION_DAYS  Days to keep backups (default: 7)
  MAX_BACKUPS         Maximum number of backups to keep (default: 10)

Examples:
  # Create backup
  $0 backup

  # List backups
  $0 list

  # Restore from backup
  $0 restore backups/aether_backup_20250104_120000.sql.gz

  # Cleanup old backups
  $0 cleanup

  # Run as cron job (daily at 2 AM)
  0 2 * * * $0 backup && $0 cleanup
EOF
}

# =============================================================================
# Preflight Checks
# =============================================================================

check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if pg_dump is available
    if ! command -v pg_dump &> /dev/null; then
        log_error "pg_dump not found. Please install PostgreSQL client tools."
        log_error "  macOS:  brew install postgresql@16"
        log_error "  Ubuntu: sudo apt install postgresql-client"
        exit 1
    fi
    log_success "PostgreSQL client tools found"
    
    # Check if gzip is available
    if ! command -v gzip &> /dev/null; then
        log_error "gzip not found. Please install gzip."
        exit 1
    fi
    log_success "Compression tools found"
    
    # Create backup directory if it doesn't exist
    if [ ! -d "$BACKUP_DIR" ]; then
        log_info "Creating backup directory: $BACKUP_DIR"
        mkdir -p "$BACKUP_DIR"
    fi
    log_success "Backup directory ready: $BACKUP_DIR"
    
    # Set PGPASSWORD for authentication
    export PGPASSWORD="$POSTGRES_PASSWORD"
}

# =============================================================================
# Backup Functions
# =============================================================================

create_backup() {
    log_info "Starting database backup..."
    echo ""
    log_info "Configuration:"
    echo "  Host:        $POSTGRES_HOST:$POSTGRES_PORT"
    echo "  Database:    $POSTGRES_DB"
    echo "  User:        $POSTGRES_USER"
    echo "  Backup File: $BACKUP_FILE"
    echo ""
    
    # Check if database is accessible
    log_info "Verifying database connection..."
    if ! psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c '\l' > /dev/null 2>&1; then
        log_error "Cannot connect to database $POSTGRES_DB"
        exit 1
    fi
    log_success "Database connection verified"
    
    # Get database size
    DB_SIZE=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -tAc "SELECT pg_size_pretty(pg_database_size(current_database()))")
    log_info "Database size: $DB_SIZE"
    
    # Create backup
    log_info "Creating backup..."
    START_TIME=$(date +%s)
    
    if pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        --format=plain \
        --no-owner \
        --no-acl \
        --verbose \
        2>&1 | gzip > "$BACKUP_FILE"; then
        
        END_TIME=$(date +%s)
        DURATION=$((END_TIME - START_TIME))
        
        # Get backup file size
        BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        
        log_success "Backup created successfully!"
        echo ""
        log_info "Backup Details:"
        echo "  File:        $BACKUP_FILE"
        echo "  Size:        $BACKUP_SIZE (compressed)"
        echo "  Duration:    ${DURATION}s"
        echo "  Timestamp:   $(date)"
        echo ""
        
        # Verify backup
        verify_backup "$BACKUP_FILE"
    else
        log_error "Backup failed!"
        # Remove partial backup file
        rm -f "$BACKUP_FILE"
        exit 1
    fi
}

verify_backup() {
    local backup_file=$1
    
    log_info "Verifying backup integrity..."
    
    # Check if file exists and is not empty
    if [ ! -f "$backup_file" ]; then
        log_error "Backup file not found: $backup_file"
        return 1
    fi
    
    if [ ! -s "$backup_file" ]; then
        log_error "Backup file is empty: $backup_file"
        return 1
    fi
    
    # Verify gzip integrity
    if gzip -t "$backup_file" 2>/dev/null; then
        log_success "Backup file integrity verified"
        return 0
    else
        log_error "Backup file is corrupted: $backup_file"
        return 1
    fi
}

# =============================================================================
# Restore Functions
# =============================================================================

restore_backup() {
    local backup_file=$1
    
    if [ -z "$backup_file" ]; then
        log_error "No backup file specified"
        show_usage
        exit 1
    fi
    
    if [ ! -f "$backup_file" ]; then
        log_error "Backup file not found: $backup_file"
        exit 1
    fi
    
    log_warn "WARNING: This will overwrite the current database!"
    log_warn "Database: $POSTGRES_DB on $POSTGRES_HOST:$POSTGRES_PORT"
    echo ""
    
    # Confirm
    if [ -t 0 ]; then
        read -p "Are you sure you want to restore? Type 'yes' to confirm: " -r
        echo
        if [[ ! $REPLY = "yes" ]]; then
            log_info "Restore cancelled"
            exit 0
        fi
    else
        log_error "Cannot restore in non-interactive mode (safety check)"
        exit 1
    fi
    
    log_info "Starting database restore..."
    
    # Verify backup before restoring
    if ! verify_backup "$backup_file"; then
        log_error "Backup verification failed, aborting restore"
        exit 1
    fi
    
    # Drop existing connections
    log_info "Terminating existing connections..."
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres <<EOF > /dev/null 2>&1
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();
EOF
    
    # Drop and recreate database
    log_info "Recreating database..."
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres <<EOF
DROP DATABASE IF EXISTS $POSTGRES_DB;
CREATE DATABASE $POSTGRES_DB OWNER $POSTGRES_USER;
EOF
    
    # Restore backup
    log_info "Restoring backup..."
    START_TIME=$(date +%s)
    
    if gunzip -c "$backup_file" | psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /dev/null 2>&1; then
        END_TIME=$(date +%s)
        DURATION=$((END_TIME - START_TIME))
        
        log_success "Restore completed successfully!"
        echo ""
        log_info "Restore Details:"
        echo "  File:      $backup_file"
        echo "  Database:  $POSTGRES_DB"
        echo "  Duration:  ${DURATION}s"
        echo ""
    else
        log_error "Restore failed!"
        exit 1
    fi
}

# =============================================================================
# List and Cleanup Functions
# =============================================================================

list_backups() {
    log_info "Available backups in $BACKUP_DIR:"
    echo ""
    
    if [ ! -d "$BACKUP_DIR" ] || [ -z "$(ls -A "$BACKUP_DIR"/*.sql.gz 2>/dev/null)" ]; then
        log_warn "No backups found"
        return
    fi
    
    echo "Timestamp            Size      Age      File"
    echo "-------------------  --------  -------  ----"
    
    for backup in "$BACKUP_DIR"/aether_backup_*.sql.gz; do
        if [ -f "$backup" ]; then
            size=$(du -h "$backup" | cut -f1)
            age=$(find "$backup" -mtime +0 -printf "%A+" 2>/dev/null || stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$backup")
            filename=$(basename "$backup")
            timestamp=$(echo "$filename" | sed 's/aether_backup_\(.*\)\.sql\.gz/\1/')
            
            echo "$timestamp  $size      $age  $filename"
        fi
    done
    echo ""
}

cleanup_old_backups() {
    log_info "Cleaning up old backups..."
    log_info "Retention policy: $RETENTION_DAYS days, max $MAX_BACKUPS backups"
    
    if [ ! -d "$BACKUP_DIR" ]; then
        log_warn "Backup directory not found, nothing to clean"
        return
    fi
    
    # Remove backups older than retention days
    DELETED_COUNT=0
    
    # Find and delete old backups
    while IFS= read -r backup; do
        if [ -f "$backup" ]; then
            log_info "Removing old backup: $(basename "$backup")"
            rm -f "$backup"
            ((DELETED_COUNT++))
        fi
    done < <(find "$BACKUP_DIR" -name "aether_backup_*.sql.gz" -type f -mtime +${RETENTION_DAYS})
    
    # Keep only MAX_BACKUPS most recent backups
    BACKUP_COUNT=$(find "$BACKUP_DIR" -name "aether_backup_*.sql.gz" -type f | wc -l)
    
    if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
        EXCESS=$((BACKUP_COUNT - MAX_BACKUPS))
        log_info "Removing $EXCESS excess backups (keeping newest $MAX_BACKUPS)"
        
        # Delete oldest excess backups
        find "$BACKUP_DIR" -name "aether_backup_*.sql.gz" -type f -print0 | \
            xargs -0 ls -t | \
            tail -n "$EXCESS" | \
            while read -r backup; do
                log_info "Removing excess backup: $(basename "$backup")"
                rm -f "$backup"
                ((DELETED_COUNT++))
            done
    fi
    
    if [ "$DELETED_COUNT" -gt 0 ]; then
        log_success "Removed $DELETED_COUNT old backup(s)"
    else
        log_info "No old backups to remove"
    fi
}

# =============================================================================
# Main Entry Point
# =============================================================================

main() {
    case "$COMMAND" in
        backup)
            check_prerequisites
            create_backup
            ;;
        
        restore)
            check_prerequisites
            restore_backup "${2:-}"
            ;;
        
        list)
            list_backups
            ;;
        
        cleanup)
            cleanup_old_backups
            ;;
        
        help|--help|-h)
            show_usage
            exit 0
            ;;
        
        *)
            log_error "Unknown command: $COMMAND"
            echo ""
            show_usage
            exit 1
            ;;
    esac
}

# Run main function
main "$@"

