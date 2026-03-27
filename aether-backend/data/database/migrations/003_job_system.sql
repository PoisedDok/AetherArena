-- ============================================================================
-- Consolidated Migration: Job System & Summaries
-- ============================================================================
-- Purpose: Automation queue, dependencies, and chat summaries
-- Version: 3.0.0 (Consolidated from 005, 011, 013, 014, 009, 031)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

-- ============================================================================
-- CHAT SUMMARIES
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    summary_type VARCHAR(50) NOT NULL DEFAULT 'full',
    title VARCHAR(500),
    summary_text TEXT NOT NULL DEFAULT '',
    key_points TEXT[],
    entities JSONB DEFAULT '{}',
    metadata JSONB NOT NULL DEFAULT '{}',
    llm_model VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(chat_id, summary_type),
    CHECK (summary_type IN ('full', 'brief', 'technical', 'executive'))
);

CREATE INDEX IF NOT EXISTS idx_chat_summaries_chat ON chat_summaries(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_type ON chat_summaries(summary_type);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_created ON chat_summaries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_summaries_title_search ON chat_summaries USING GIN (to_tsvector('english', COALESCE(title, '')));
CREATE INDEX IF NOT EXISTS idx_chat_summaries_text_search ON chat_summaries USING GIN (to_tsvector('english', summary_text));
CREATE INDEX IF NOT EXISTS idx_chat_summaries_keypoints_search ON chat_summaries USING GIN (to_tsvector('english', array_to_string(key_points, ' ')));

CREATE OR REPLACE FUNCTION update_chat_summary_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_chat_summary_timestamp BEFORE UPDATE ON chat_summaries FOR EACH ROW EXECUTE FUNCTION update_chat_summary_timestamp();

-- ============================================================================
-- AUTOMATION JOBS
-- ============================================================================
CREATE TABLE IF NOT EXISTS pending_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    
    execution_strategy VARCHAR(20) NOT NULL DEFAULT 'parallel' CHECK (execution_strategy IN ('parallel', 'sequential', 'batch')),
    depends_on UUID REFERENCES pending_jobs(id) ON DELETE SET NULL,
    batch_group VARCHAR(100),
    resource_cost INTEGER NOT NULL DEFAULT 3 CHECK (resource_cost >= 1 AND resource_cost <= 10),
    -- Will add agent_name in agent migration
    agent_name VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_pending_jobs_status ON pending_jobs(status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_pending_jobs_priority ON pending_jobs(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_pending_jobs_type ON pending_jobs(job_type);
CREATE INDEX IF NOT EXISTS idx_pending_jobs_started_at ON pending_jobs(started_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_pending_jobs_depends_on ON pending_jobs(depends_on) WHERE depends_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pending_jobs_batch_group ON pending_jobs(batch_group) WHERE batch_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pending_jobs_resource_cost ON pending_jobs(resource_cost, priority DESC, created_at ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_jobs_scheduling ON pending_jobs(status, execution_strategy, priority DESC, created_at ASC) WHERE status IN ('pending', 'processing');

-- ============================================================================
-- JOB QUEUE FUNCTIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION queue_chat_summarization()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.role = 'assistant' THEN
        INSERT INTO pending_jobs (job_type, entity_id, entity_type, priority, metadata)
        VALUES ('summarize_chat', NEW.chat_id, 'chat', 7, jsonb_build_object('message_id', NEW.id, 'chat_id', NEW.chat_id))
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_queue_summarization AFTER INSERT ON messages FOR EACH ROW WHEN (NEW.role = 'assistant') EXECUTE FUNCTION queue_chat_summarization();

CREATE OR REPLACE FUNCTION queue_memory_extraction_from_groups()
RETURNS TRIGGER AS $$
DECLARE
    v_group_frequency INTEGER;
    v_memory_enabled BOOLEAN;
BEGIN
    v_group_frequency := COALESCE(current_setting('app.memory_group_frequency', true)::INTEGER, 5);
    v_memory_enabled := COALESCE(current_setting('app.memory_agent_enabled', true)::BOOLEAN, true);
    
    IF v_memory_enabled AND (NEW.sequence_number % v_group_frequency = 0) THEN
        INSERT INTO pending_jobs (job_type, entity_id, entity_type, priority, metadata)
        VALUES ('extract_memories', NEW.chat_id, 'chat', 6, jsonb_build_object('chat_id', NEW.chat_id, 'group_sequence', NEW.sequence_number, 'groups_to_process', v_group_frequency))
        ON CONFLICT DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_queue_memory_extraction_from_groups AFTER INSERT ON groups FOR EACH ROW EXECUTE FUNCTION queue_memory_extraction_from_groups();

CREATE OR REPLACE FUNCTION get_recent_chat_groups(p_chat_id UUID, p_count INTEGER DEFAULT 5)
RETURNS TABLE (group_id UUID, sequence_number INTEGER, user_message TEXT, agent_message TEXT, user_message_id UUID, agent_message_id UUID, created_at TIMESTAMPTZ) AS $$
BEGIN RETURN QUERY SELECT g.id, g.sequence_number, g.user_message, g.agent_message, g.user_message_id, g.agent_message_id, g.created_at FROM groups g WHERE g.chat_id = p_chat_id ORDER BY g.sequence_number DESC LIMIT p_count; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION check_job_dependencies(p_job_id UUID) RETURNS BOOLEAN AS $$ DECLARE v_depends_on UUID; v_parent_status VARCHAR(20); BEGIN SELECT depends_on INTO v_depends_on FROM pending_jobs WHERE id = p_job_id; IF v_depends_on IS NULL THEN RETURN TRUE; END IF; SELECT status INTO v_parent_status FROM pending_jobs WHERE id = v_depends_on; RETURN v_parent_status = 'completed'; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION get_current_resource_usage() RETURNS INTEGER AS $$ DECLARE v_total_cost INTEGER; BEGIN SELECT COALESCE(SUM(resource_cost), 0) INTO v_total_cost FROM pending_jobs WHERE status = 'processing'; RETURN v_total_cost; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_next_pending_job_v2(p_max_resource_cost INTEGER DEFAULT 10) RETURNS SETOF pending_jobs AS $$ DECLARE v_current_usage INTEGER; v_available_budget INTEGER; v_job pending_jobs; BEGIN v_current_usage := get_current_resource_usage(); v_available_budget := p_max_resource_cost - v_current_usage; IF v_available_budget <= 0 THEN RETURN; END IF; FOR v_job IN SELECT * FROM pending_jobs p WHERE p.status = 'pending' AND p.resource_cost <= v_available_budget AND check_job_dependencies(p.id) = TRUE ORDER BY p.priority DESC, p.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED LOOP UPDATE pending_jobs SET status = 'processing', started_at = NOW() WHERE id = v_job.id; v_job.status := 'processing'; v_job.started_at := NOW(); RETURN NEXT v_job; RETURN; END LOOP; RETURN; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_pending_jobs_batch(p_batch_size INTEGER DEFAULT 5, p_max_resource_cost INTEGER DEFAULT 10) RETURNS SETOF pending_jobs AS $$ DECLARE v_current_usage INTEGER; v_available_budget INTEGER; v_job pending_jobs; v_jobs_returned INTEGER := 0; v_accumulated_cost INTEGER := 0; BEGIN v_current_usage := get_current_resource_usage(); v_available_budget := p_max_resource_cost - v_current_usage; IF v_available_budget <= 0 THEN RETURN; END IF; FOR v_job IN SELECT * FROM pending_jobs p WHERE p.status = 'pending' AND check_job_dependencies(p.id) = TRUE ORDER BY p.priority DESC, p.created_at ASC FOR UPDATE SKIP LOCKED LOOP IF (v_accumulated_cost + v_job.resource_cost) <= v_available_budget THEN UPDATE pending_jobs SET status = 'processing', started_at = NOW() WHERE id = v_job.id; v_job.status := 'processing'; v_job.started_at := NOW(); RETURN NEXT v_job; v_accumulated_cost := v_accumulated_cost + v_job.resource_cost; v_jobs_returned := v_jobs_returned + 1; IF v_jobs_returned >= p_batch_size THEN RETURN; END IF; END IF; END LOOP; RETURN; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION process_pending_jobs_batch(p_batch_size INTEGER DEFAULT 5, p_job_types TEXT[] DEFAULT NULL) RETURNS TABLE (processed_count INTEGER, success_count INTEGER, failure_count INTEGER) AS $$ DECLARE v_job RECORD; v_processed INTEGER := 0; v_success INTEGER := 0; v_failure INTEGER := 0; BEGIN FOR v_job IN SELECT * FROM get_next_pending_job(p_job_types) LIMIT p_batch_size LOOP v_processed := v_processed + 1; BEGIN IF v_job.job_type = 'summarize_chat' THEN PERFORM complete_job(v_job.id); v_success := v_success + 1; ELSIF v_job.job_type = 'extract_memories' THEN PERFORM complete_job(v_job.id); v_success := v_success + 1; ELSIF v_job.job_type = 'consolidate_memories' THEN PERFORM complete_job(v_job.id); v_success := v_success + 1; ELSE PERFORM fail_job(v_job.id, 'Unknown job type: ' || v_job.job_type, FALSE); v_failure := v_failure + 1; END IF; EXCEPTION WHEN OTHERS THEN PERFORM fail_job(v_job.id, SQLERRM, FALSE); v_failure := v_failure + 1; END; END LOOP; RETURN QUERY SELECT v_processed, v_success, v_failure; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION complete_job(p_job_id UUID) RETURNS VOID AS $$ BEGIN UPDATE pending_jobs SET status = 'completed', completed_at = NOW() WHERE id = p_job_id; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION fail_job(p_job_id UUID, p_error_message TEXT, p_retry BOOLEAN DEFAULT FALSE) RETURNS VOID AS $$ BEGIN UPDATE pending_jobs SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' WHEN p_retry = TRUE THEN 'pending' ELSE 'failed' END, retry_count = retry_count + 1, error_message = COALESCE(error_message, '') || CASE WHEN COALESCE(error_message, '') = '' THEN p_error_message ELSE ' | ' || p_error_message END WHERE id = p_job_id; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION cleanup_old_jobs() RETURNS INTEGER AS $$ DECLARE v_deleted_count INTEGER; BEGIN DELETE FROM pending_jobs WHERE status IN ('completed', 'failed') AND completed_at < NOW() - INTERVAL '7 days'; GET DIAGNOSTICS v_deleted_count = ROW_COUNT; RETURN v_deleted_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION reset_stale_processing_jobs(p_timeout_minutes INTEGER DEFAULT 30) RETURNS INTEGER AS $$ DECLARE v_updated_count INTEGER; BEGIN UPDATE pending_jobs SET status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE 'pending' END, retry_count = retry_count + 1, error_message = COALESCE(error_message, '') || format(' | Auto-reset stale job (timeout: %s minutes)', p_timeout_minutes) WHERE status = 'processing' AND started_at IS NOT NULL AND started_at < NOW() - (p_timeout_minutes || ' minutes')::INTERVAL; GET DIAGNOSTICS v_updated_count = ROW_COUNT; RETURN v_updated_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION queue_global_memory_consolidation() RETURNS VOID AS $$ BEGIN INSERT INTO pending_jobs (job_type, entity_id, entity_type, priority, metadata) VALUES ('consolidate_memories', gen_random_uuid(), 'global', 3, jsonb_build_object('similarity_threshold', 0.95)) ON CONFLICT DO NOTHING; END; $$ LANGUAGE plpgsql;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON chat_summaries, pending_jobs TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION queue_memory_extraction_from_groups(), get_recent_chat_groups(UUID, INTEGER), check_job_dependencies(UUID), get_current_resource_usage(), get_next_pending_job_v2(INTEGER), get_pending_jobs_batch(INTEGER, INTEGER), complete_job(UUID), fail_job(UUID, TEXT, BOOLEAN), cleanup_old_jobs(), reset_stale_processing_jobs(INTEGER), queue_global_memory_consolidation() TO anon, authenticated, service_role;
