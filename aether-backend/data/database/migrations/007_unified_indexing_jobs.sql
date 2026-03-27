-- ============================================================================
-- Migration: Unified Indexing Jobs
-- ============================================================================
-- Purpose: Expand reindex_jobs to support generic source types (browser, email)
-- Version: 1.0.0
-- Date: 2026-03-07
-- Author: Aether Architect
-- ============================================================================

ALTER TABLE public.reindex_jobs ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) NOT NULL DEFAULT 'filesystem';

ALTER TABLE public.reindex_jobs DROP CONSTRAINT IF EXISTS reindex_jobs_location_id_fkey;

ALTER TABLE public.reindex_jobs ALTER COLUMN location_id DROP NOT NULL;

ALTER TABLE public.reindex_jobs ADD CONSTRAINT reindex_jobs_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.file_indexing_locations(id) ON DELETE CASCADE;

ALTER TABLE public.reindex_jobs DROP CONSTRAINT IF EXISTS unique_active_job_per_location;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_job_per_source_location ON public.reindex_jobs(source_type, location_name) WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_reindex_jobs_source_type ON public.reindex_jobs(source_type);

NOTIFY pgrst, 'reload schema';