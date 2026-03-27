-- ============================================================================
-- Consolidated Migration: Audit & Traceability System
-- ============================================================================
-- Purpose: Normalized audit/event records, integration health, and legal events
-- Version: 3.0.0 (Consolidated from 001, 037)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

-- ============================================================================
-- EVENTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source VARCHAR(32) NOT NULL CHECK (source IN ('http','ws','cli','runtime','job')),
    event_type VARCHAR(128) NOT NULL,
    severity VARCHAR(16) NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warning','error','critical')),
    request_id UUID,
    correlation_id UUID,
    session_id UUID,
    user_id UUID,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_events_occurred_at ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);
CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source, event_type);

-- ============================================================================
-- MESSAGE-ARTIFACT LINK
-- ============================================================================
CREATE TABLE IF NOT EXISTS message_artifact_link (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_id UUID REFERENCES events(id) ON DELETE SET NULL,
    UNIQUE(message_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_artifact_message ON message_artifact_link(message_id);
CREATE INDEX IF NOT EXISTS idx_msg_artifact_artifact ON message_artifact_link(artifact_id);
CREATE INDEX IF NOT EXISTS idx_msg_artifact_created ON message_artifact_link(created_at DESC);

-- ============================================================================
-- INTEGRATION HEALTH
-- ============================================================================
CREATE TABLE IF NOT EXISTS integration_health (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'unknown' CHECK (status IN ('healthy','degraded','unhealthy','unknown')),
    last_checked TIMESTAMPTZ,
    last_error TEXT,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_health_status ON integration_health(status);
CREATE INDEX IF NOT EXISTS idx_integration_health_checked ON integration_health(last_checked DESC);

CREATE OR REPLACE FUNCTION update_integration_health_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_integration_health
    BEFORE UPDATE ON integration_health
    FOR EACH ROW EXECUTE FUNCTION update_integration_health_timestamp();

-- ============================================================================
-- LEGAL ACCEPTANCE EVENTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS legal_acceptance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL DEFAULT 'default_user',
    terms_version VARCHAR(64) NOT NULL,
    terms_hash VARCHAR(128) NOT NULL,
    acceptance_method VARCHAR(32) NOT NULL DEFAULT 'checkbox',
    app_version VARCHAR(64),
    platform VARCHAR(64),
    source VARCHAR(64) NOT NULL DEFAULT 'onboarding_modal',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptance_user_accepted_at ON legal_acceptance_events(user_id, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_legal_acceptance_terms_version ON legal_acceptance_events(terms_version);

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON events, message_artifact_link, integration_health, legal_acceptance_events TO anon, authenticated, service_role;
