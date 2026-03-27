-- ============================================================================
-- Consolidated Migration: Agent System
-- ============================================================================
-- Purpose: AI agents, configurations, and deep-planning proactive agents.
-- Version: 3.0.0 (Consolidated from 010, 012, 026, 027, 033-035, 038)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- AGENT CONFIGS & OUTPUTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name VARCHAR(50) UNIQUE NOT NULL,
    agent_type VARCHAR(50) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    model_name VARCHAR(100) NOT NULL,
    prompt_template TEXT NOT NULL,
    execution_trigger VARCHAR(50) NOT NULL,
    trigger_frequency INTEGER,
    configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CHECK (agent_type IN ('memory', 'research', 'risk')),
    CHECK (execution_trigger IN ('background', 'on_demand', 'scheduled')),
    CHECK (trigger_frequency IS NULL OR trigger_frequency > 0),
    CHECK (jsonb_typeof(configuration) = 'object'),
    CHECK (LENGTH(TRIM(agent_name)) > 0),
    CHECK (LENGTH(TRIM(model_name)) > 0),
    CHECK (LENGTH(TRIM(prompt_template)) > 0)
);

CREATE TABLE IF NOT EXISTS agent_outputs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_name VARCHAR(50) NOT NULL REFERENCES agent_configs(agent_name) ON DELETE CASCADE,
    job_id UUID REFERENCES pending_jobs(id) ON DELETE SET NULL,
    output_type VARCHAR(50) NOT NULL,
    content JSONB NOT NULL,
    aether_rag_index_name VARCHAR(100),
    entity_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CHECK (output_type IN ('memory', 'research')),
    CHECK (jsonb_typeof(content) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_agent_configs_enabled ON agent_configs(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_agent_configs_type ON agent_configs(agent_type);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_agent ON agent_outputs(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_type ON agent_outputs(output_type);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_job ON agent_outputs(job_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_entity ON agent_outputs(entity_id);
CREATE INDEX IF NOT EXISTS idx_agent_outputs_created ON agent_outputs(created_at DESC);

-- Foreign key on pending_jobs handled directly in the base create table for pending_jobs now?
-- Actually, pending_jobs was created in 003. We will add the FK constraint here for proper ordering.
ALTER TABLE pending_jobs ADD CONSTRAINT fk_pending_jobs_agent_name FOREIGN KEY (agent_name) REFERENCES agent_configs(agent_name) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pending_jobs_agent ON pending_jobs(agent_name) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION update_agent_config_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_agent_config_timestamp BEFORE UPDATE ON agent_configs FOR EACH ROW EXECUTE FUNCTION update_agent_config_timestamp();

-- ============================================================================
-- PROACTIVE AGENT RUNS
-- ============================================================================
CREATE TABLE IF NOT EXISTS proactive_agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_ids TEXT[] NOT NULL,
    queries TEXT[] NOT NULL,
    source_docs JSONB NOT NULL,
    day_date DATE NOT NULL,
    
    agent_mode VARCHAR(20) NOT NULL,
    llm_model VARCHAR(100),
    tool_calls_count INTEGER,
    execution_time_ms INTEGER,
    
    decision VARCHAR(20) NOT NULL,
    relevance_score REAL,
    defer_reason TEXT,
    
    context_gathered JSONB,
    recommendation TEXT,
    supporting_docs JSONB,
    reasoning_traces TEXT[],
    executed_tools JSONB,
    
    shown_to_user BOOLEAN DEFAULT FALSE,
    user_feedback VARCHAR(20),
    feedback_timestamp TIMESTAMPTZ,
    
    session_id UUID,
    
    context_embedding vector(384),
    embedding_model VARCHAR(100),
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proactive_runs_day ON proactive_agent_runs(day_date DESC);
CREATE INDEX IF NOT EXISTS idx_proactive_runs_decision ON proactive_agent_runs(decision);
CREATE INDEX IF NOT EXISTS idx_proactive_runs_shown ON proactive_agent_runs(shown_to_user);
CREATE INDEX IF NOT EXISTS idx_proactive_runs_feedback ON proactive_agent_runs(user_feedback) WHERE user_feedback IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proactive_runs_session ON proactive_agent_runs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_proactive_runs_context ON proactive_agent_runs USING GIN(context_gathered);
CREATE INDEX IF NOT EXISTS idx_proactive_runs_embedding ON proactive_agent_runs USING ivfflat (context_embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- PROACTIVE AGENT QUEUE
-- ============================================================================
CREATE TABLE IF NOT EXISTS proactive_agent_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query_ids TEXT[] NOT NULL,
    day_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    agent_run_id UUID REFERENCES proactive_agent_runs(id),
    error_message TEXT,
    retry_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_proactive_queue_status ON proactive_agent_queue(status) WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_proactive_queue_priority ON proactive_agent_queue(priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_proactive_queue_day ON proactive_agent_queue(day_date DESC);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================
CREATE OR REPLACE FUNCTION get_proactive_queue_stats() RETURNS TABLE (pending_count BIGINT, processing_count BIGINT, failed_count BIGINT, oldest_pending TIMESTAMPTZ) AS $$ BEGIN RETURN QUERY SELECT COUNT(*) FILTER (WHERE status = 'pending') as pending_count, COUNT(*) FILTER (WHERE status = 'processing') as processing_count, COUNT(*) FILTER (WHERE status = 'failed' AND retry_count < 3) as failed_count, MIN(created_at) FILTER (WHERE status = 'pending') as oldest_pending FROM proactive_agent_queue; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_proactive_feedback_stats(days_back INTEGER DEFAULT 7) RETURNS TABLE (total_shown BIGINT, clicked_count BIGINT, dismissed_count BIGINT, timeout_count BIGINT, click_rate NUMERIC) AS $$ DECLARE cutoff TIMESTAMPTZ := NOW() - (days_back || ' days')::INTERVAL; BEGIN RETURN QUERY SELECT COUNT(*) as total_shown, COUNT(*) FILTER (WHERE user_feedback = 'clicked') as clicked_count, COUNT(*) FILTER (WHERE user_feedback = 'dismissed') as dismissed_count, COUNT(*) FILTER (WHERE user_feedback = 'timeout') as timeout_count, ROUND(COUNT(*) FILTER (WHERE user_feedback = 'clicked')::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2) as click_rate FROM proactive_agent_runs WHERE (shown_to_user = TRUE OR user_feedback IS NOT NULL) AND created_at >= cutoff; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_similar_proactive_runs(query_embedding vector(384), similarity_threshold REAL DEFAULT 0.7, require_positive_feedback BOOLEAN DEFAULT TRUE, limit_results INTEGER DEFAULT 5, embedding_model_name VARCHAR(100) DEFAULT NULL) RETURNS TABLE (run_id UUID, similarity_score REAL, decision VARCHAR(20), recommendation TEXT, user_feedback VARCHAR(20), created_at TIMESTAMPTZ) AS $$ BEGIN RETURN QUERY SELECT r.id as run_id, (1 - (r.context_embedding <=> query_embedding))::REAL as similarity_score, r.decision, r.recommendation, r.user_feedback, r.created_at FROM proactive_agent_runs r WHERE r.context_embedding IS NOT NULL AND r.decision = 'intervene' AND r.recommendation IS NOT NULL AND (NOT require_positive_feedback OR r.user_feedback = 'clicked') AND (1 - (r.context_embedding <=> query_embedding)) >= similarity_threshold AND (embedding_model_name IS NULL OR r.embedding_model = embedding_model_name) ORDER BY similarity_score DESC, r.created_at DESC LIMIT limit_results; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_proactive_runs(input_queries TEXT[], similarity_threshold INTEGER DEFAULT 1, limit_results INTEGER DEFAULT 10) RETURNS TABLE (run_id UUID, matched_queries INTEGER, decision VARCHAR(20), user_feedback VARCHAR(20), created_at TIMESTAMPTZ) AS $$ BEGIN RETURN QUERY SELECT r.id as run_id, CARDINALITY(ARRAY(SELECT UNNEST(r.queries) INTERSECT SELECT UNNEST(input_queries))) as matched_queries, r.decision, r.user_feedback, r.created_at FROM proactive_agent_runs r WHERE CARDINALITY(ARRAY(SELECT UNNEST(r.queries) INTERSECT SELECT UNNEST(input_queries))) >= similarity_threshold ORDER BY matched_queries DESC, created_at DESC LIMIT limit_results; END; $$ LANGUAGE plpgsql;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON agent_configs, agent_outputs, proactive_agent_runs, proactive_agent_queue TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_proactive_queue_stats(), get_proactive_feedback_stats(INTEGER), search_similar_proactive_runs(vector, REAL, BOOLEAN, INTEGER, VARCHAR), find_similar_proactive_runs(TEXT[], INTEGER, INTEGER) TO anon, authenticated, service_role;
