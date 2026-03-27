-- ============================================================================
-- Consolidated Migration: File Indexing
-- ============================================================================
-- Purpose: Complete file indexing system with AETHER-RAG semantic search integration.
-- Version: 3.0.0 (Consolidated from 006)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

-- ============================================================================
-- FILE INDEXING LOCATIONS
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_indexing_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_name VARCHAR(200) NOT NULL UNIQUE,
    root_path TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    location_type VARCHAR(20) NOT NULL DEFAULT 'secondary' CHECK (location_type IN ('primary', 'secondary')),
    index_mode VARCHAR(20) NOT NULL DEFAULT 'combined' CHECK (index_mode IN ('semantic', 'bm25', 'combined')),
    index_name VARCHAR(100) NOT NULL UNIQUE,
    index_directory TEXT NOT NULL,
    scan_interval_minutes INTEGER NOT NULL DEFAULT 15,
    watch_enabled BOOLEAN NOT NULL DEFAULT true,
    watch_directories JSONB DEFAULT '[]',
    allowed_extensions JSONB NOT NULL DEFAULT '["pdf","txt","md","docx","json","yaml","yml","csv","rtf"]',
    exclude_patterns JSONB NOT NULL DEFAULT '["**/.git/**", "**/node_modules/**", "**/__pycache__/**", "**/.venv/**", "**/build/**", "**/dist/**", "**/.Trashes/**", "**/.fseventsd/**", "**/.Spotlight-V100/**"]',
    chunk_size INTEGER NOT NULL DEFAULT 512,
    chunk_overlap INTEGER NOT NULL DEFAULT 50,
    last_scan_at TIMESTAMPTZ,
    last_scan_status VARCHAR(20) DEFAULT 'pending',
    last_scan_error TEXT,
    last_scan_duration_seconds INTEGER,
    file_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    index_size_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (last_scan_status IN ('pending', 'running', 'completed', 'failed'))
);

-- ============================================================================
-- INDEXED FILES
-- ============================================================================
CREATE TABLE IF NOT EXISTS indexed_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES file_indexing_locations(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    file_extension VARCHAR(20) NOT NULL,
    mime_type VARCHAR(100),
    content_hash VARCHAR(64) NOT NULL,
    file_modified_at TIMESTAMPTZ NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    creation_date TIMESTAMPTZ,
    modification_date TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'indexed',
    error_message TEXT,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', file_name || ' ' || COALESCE(file_path, ''))) STORED,
    UNIQUE(location_id, file_path),
    CHECK (status IN ('indexed', 'pending', 'failed', 'deleted'))
);

-- ============================================================================
-- FILE INDEXING HEALTH
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_indexing_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_status VARCHAR(20) NOT NULL DEFAULT 'stopped',
    last_heartbeat TIMESTAMPTZ,
    process_id INTEGER,
    active_location_id UUID REFERENCES file_indexing_locations(id),
    current_operation VARCHAR(50),
    operation_progress JSONB DEFAULT '{}',
    error_message TEXT,
    consecutive_errors INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (service_status IN ('stopped', 'running', 'idle', 'error'))
);

-- ============================================================================
-- FILE INDEXING CONFIG
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_indexing_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aether_rag_embedding_model VARCHAR(200) NOT NULL DEFAULT 'aether-inference',
    heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 30,
    scan_check_interval_seconds INTEGER NOT NULL DEFAULT 60,
    max_concurrent_scans INTEGER NOT NULL DEFAULT 1,
    log_level VARCHAR(20) NOT NULL DEFAULT 'INFO',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT enforce_single_config CHECK (id = '00000000-0000-0000-0000-000000000001')
);

INSERT INTO file_indexing_config (id, aether_rag_embedding_model, heartbeat_interval_seconds, scan_check_interval_seconds, max_concurrent_scans, log_level)
VALUES ('00000000-0000-0000-0000-000000000001', 'aether-inference', 30, 60, 1, 'INFO')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- REINDEX JOBS
-- ============================================================================
CREATE TABLE IF NOT EXISTS reindex_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES file_indexing_locations(id) ON DELETE CASCADE,
    location_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    progress_phase VARCHAR(100) NOT NULL DEFAULT 'initializing',
    files_scanned INTEGER DEFAULT 0,
    files_total INTEGER DEFAULT 0,
    chunks_processed INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checkpoint_data JSONB DEFAULT '{}',
    CONSTRAINT unique_active_job_per_location EXCLUDE (location_id WITH =) WHERE (status IN ('queued', 'running'))
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE TABLE IF NOT EXISTS search_indexes (
    index_name VARCHAR(100) PRIMARY KEY,
    source_type VARCHAR(50) NOT NULL,
    index_directory TEXT NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    display_name VARCHAR(200),
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_indexes_type ON search_indexes(source_type);

CREATE INDEX IF NOT EXISTS idx_file_locations_enabled ON file_indexing_locations(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_file_locations_updated ON file_indexing_locations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_locations_type ON file_indexing_locations(location_type);
CREATE INDEX IF NOT EXISTS idx_indexed_files_location ON indexed_files(location_id);
CREATE INDEX IF NOT EXISTS idx_indexed_files_status ON indexed_files(status);
CREATE INDEX IF NOT EXISTS idx_indexed_files_hash ON indexed_files(content_hash);
CREATE INDEX IF NOT EXISTS idx_indexed_files_search ON indexed_files USING GIN(search_vector);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_indexing_config_single ON file_indexing_config (id);
CREATE INDEX IF NOT EXISTS idx_reindex_jobs_location_status ON reindex_jobs(location_id, status);
CREATE INDEX IF NOT EXISTS idx_reindex_jobs_status_created ON reindex_jobs(status, created_at DESC);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_file_indexing_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_location_timestamp BEFORE UPDATE ON file_indexing_locations FOR EACH ROW EXECUTE FUNCTION update_file_indexing_timestamp();
CREATE TRIGGER trigger_update_health_timestamp BEFORE UPDATE ON file_indexing_health FOR EACH ROW EXECUTE FUNCTION update_file_indexing_timestamp();

CREATE OR REPLACE FUNCTION update_file_indexing_config_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_file_indexing_config_timestamp BEFORE UPDATE ON file_indexing_config FOR EACH ROW EXECUTE FUNCTION update_file_indexing_config_timestamp();

CREATE OR REPLACE FUNCTION update_reindex_jobs_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_reindex_jobs_timestamp BEFORE UPDATE ON reindex_jobs FOR EACH ROW EXECUTE FUNCTION update_reindex_jobs_timestamp();

CREATE OR REPLACE FUNCTION update_search_indexes_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_search_indexes_timestamp BEFORE UPDATE ON search_indexes FOR EACH ROW EXECUTE FUNCTION update_search_indexes_timestamp();

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON file_indexing_locations, indexed_files, file_indexing_health, file_indexing_config, reindex_jobs, search_indexes TO anon, authenticated, service_role;
