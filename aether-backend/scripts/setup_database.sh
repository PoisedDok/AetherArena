#!/bin/bash
# =============================================================================
# Aether Backend - Database Setup Script
# =============================================================================
# Production-ready PostgreSQL database initialization
# Creates users, databases, extensions, and applies schemas
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

# PostgreSQL connection settings (from environment or defaults)
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-postgres}"
POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-}"

# Application database settings
POSTGRES_USER="${POSTGRES_USER:-aether_user}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-aether_pass}"
POSTGRES_DB="${POSTGRES_DB:-aether_dev}"
POSTGRES_TEST_DB="${POSTGRES_TEST_DB:-aether_test}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/data/database/migrations"

# =============================================================================
# Preflight Checks
# =============================================================================

log_info "Starting Aether Backend Database Setup"
echo ""
log_info "Configuration:"
echo "  Host:          $POSTGRES_HOST:$POSTGRES_PORT"
echo "  Admin User:    $POSTGRES_ADMIN_USER"
echo "  App User:      $POSTGRES_USER"
echo "  Main Database: $POSTGRES_DB"
echo "  Test Database: $POSTGRES_TEST_DB"
echo "  Migrations:    $MIGRATIONS_DIR"
echo ""

# Check if PostgreSQL is running
log_info "Checking PostgreSQL connection..."
if [ -n "$POSTGRES_ADMIN_PASSWORD" ]; then
    export PGPASSWORD="$POSTGRES_ADMIN_PASSWORD"
fi

if ! psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" -c '\l' > /dev/null 2>&1; then
    log_error "Cannot connect to PostgreSQL at $POSTGRES_HOST:$POSTGRES_PORT"
    log_error "Please ensure PostgreSQL is running:"
    log_error "  macOS:  brew services start postgresql@16"
    log_error "  Linux:  sudo systemctl start postgresql"
    log_error "  Docker: docker run --name postgres -p 5432:5432 -e POSTGRES_PASSWORD=postgres -d postgres:16"
    exit 1
fi
log_success "PostgreSQL connection verified"

# Check if migration files exist
if [ ! -d "$MIGRATIONS_DIR" ]; then
    log_error "Migrations directory not found: $MIGRATIONS_DIR"
    exit 1
fi

if [ ! -f "$MIGRATIONS_DIR/schema.sql" ]; then
    log_error "Main schema file not found: $MIGRATIONS_DIR/schema.sql"
    exit 1
fi

if [ ! -f "$MIGRATIONS_DIR/mcp_schema.sql" ]; then
    log_error "MCP schema file not found: $MIGRATIONS_DIR/mcp_schema.sql"
    exit 1
fi
log_success "Migration files found"

# =============================================================================
# User Creation
# =============================================================================

log_info "Creating application user..."

# Check if user exists
USER_EXISTS=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" \
    -tAc "SELECT 1 FROM pg_user WHERE usename = '$POSTGRES_USER'" || echo "")

if [ "$USER_EXISTS" = "1" ]; then
    log_warn "User '$POSTGRES_USER' already exists, skipping creation"
else
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" <<EOF
CREATE USER $POSTGRES_USER WITH PASSWORD '$POSTGRES_PASSWORD';
ALTER USER $POSTGRES_USER WITH CREATEDB;
EOF
    log_success "User '$POSTGRES_USER' created"
fi

# =============================================================================
# Database Creation
# =============================================================================

create_database() {
    local db_name=$1
    local db_type=$2
    
    log_info "Creating $db_type database '$db_name'..."
    
    # Check if database exists
    DB_EXISTS=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" \
        -tAc "SELECT 1 FROM pg_database WHERE datname = '$db_name'" || echo "")
    
    if [ "$DB_EXISTS" = "1" ]; then
        log_warn "Database '$db_name' already exists"
        
        # Ask for confirmation to drop and recreate (only in interactive mode)
        if [ -t 0 ]; then
            read -p "Drop and recreate database '$db_name'? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "Dropping database '$db_name'..."
                psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" \
                    -c "DROP DATABASE IF EXISTS $db_name;"
                log_success "Database dropped"
            else
                log_warn "Skipping database recreation"
                return 0
            fi
        else
            log_warn "Non-interactive mode: keeping existing database"
            return 0
        fi
    fi
    
    # Create database
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_ADMIN_USER" <<EOF
CREATE DATABASE $db_name OWNER $POSTGRES_USER;
GRANT ALL PRIVILEGES ON DATABASE $db_name TO $POSTGRES_USER;
EOF
    log_success "Database '$db_name' created"
}

# Create main database
create_database "$POSTGRES_DB" "main"

# Create test database
create_database "$POSTGRES_TEST_DB" "test"

# =============================================================================
# Extensions Installation
# =============================================================================

install_extensions() {
    local db_name=$1
    
    log_info "Installing extensions in '$db_name'..."
    
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db_name" <<EOF
-- UUID support
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Full-text search (already included in PostgreSQL)
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- Trigram matching for fuzzy search

-- Vector search (optional, for semantic search)
-- Uncomment if pgvector is installed:
-- CREATE EXTENSION IF NOT EXISTS vector;
EOF
    
    log_success "Extensions installed in '$db_name'"
}

install_extensions "$POSTGRES_DB"
install_extensions "$POSTGRES_TEST_DB"

# =============================================================================
# Schema Application
# =============================================================================

apply_schema() {
    local db_name=$1
    local schema_type=$2
    
    log_info "Applying $schema_type to '$db_name'..."
    
    # Apply main chat schema
    log_info "  - Applying chat schema..."
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db_name" \
        -f "$MIGRATIONS_DIR/schema.sql" > /dev/null
    log_success "  ✓ Chat schema applied (chats, messages, artifacts)"
    
    # Apply MCP schema
    log_info "  - Applying MCP schema..."
    psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$db_name" \
        -f "$MIGRATIONS_DIR/mcp_schema.sql" > /dev/null
    log_success "  ✓ MCP schema applied (servers, tools, executions, memory)"
    
    log_success "All schemas applied to '$db_name'"
}

# Apply schemas to main database
apply_schema "$POSTGRES_DB" "production schemas"

# Apply schemas to test database
apply_schema "$POSTGRES_TEST_DB" "test schemas"

# =============================================================================
# Verification
# =============================================================================

log_info "Verifying database setup..."

# Count tables
TABLE_COUNT=$(psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")

if [ "$TABLE_COUNT" -ge 10 ]; then
    log_success "Database verification passed ($TABLE_COUNT tables created)"
else
    log_error "Database verification failed (expected 10+ tables, found $TABLE_COUNT)"
    exit 1
fi

# List created tables
log_info "Created tables:"
psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;" \
    | sed 's/^/  /'

# =============================================================================
# Connection String Generation
# =============================================================================

echo ""
log_success "==================================="
log_success "Database Setup Complete!"
log_success "==================================="
echo ""
log_info "Connection Details:"
echo ""
echo "  Main Database:"
echo "    postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
echo ""
echo "  Test Database:"
echo "    postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_TEST_DB"
echo ""
log_info "Environment Variables:"
echo ""
echo "  export DATABASE_URL=\"postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB\""
echo "  export DATABASE_TEST_URL=\"postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@$POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_TEST_DB\""
echo ""
log_info "Next Steps:"
echo "  1. Set DATABASE_URL in your .env file or environment"
echo "  2. Run the backend: cd $PROJECT_ROOT && python main.py"
echo "  3. Run tests: cd $PROJECT_ROOT && pytest tests/"
echo ""
log_success "Setup complete!"

