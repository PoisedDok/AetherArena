-- ============================================================================
-- Consolidated Migration: Preferences & Settings
-- ============================================================================
-- Purpose: User preferences, settings, API Keys.
-- Version: 3.0.0 (Consolidated from 007, 024, 025, 028, 029, 030, 032)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

-- ============================================================================
-- USER PREFERENCES & SETTINGS
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key TEXT NOT NULL UNIQUE,
    setting_value JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL DEFAULT 'default_user',
    preference_key TEXT NOT NULL,
    preference_value JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_user_key ON user_preferences(user_id, preference_key);

CREATE OR REPLACE FUNCTION update_user_preferences_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_user_preferences_timestamp BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION update_user_preferences_timestamp();


INSERT INTO user_preferences (user_id, preference_key, preference_value)
VALUES ('default_user', 'integrations', '{"aether_rag_sources": {"enabled": true, "browser_history": {"enabled": true}, "email": {"enabled": true}, "slack": {"enabled": false}}}'::jsonb)
ON CONFLICT (user_id, preference_key) DO NOTHING;

INSERT INTO user_preferences (user_id, preference_key, preference_value)
VALUES ('default_user', 'security', '{"allow_local_os_tools": true}'::jsonb)
ON CONFLICT (user_id, preference_key) DO NOTHING;


-- ============================================================================
-- API KEYS (Secure storage)
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_name TEXT NOT NULL UNIQUE,
    key_value TEXT NOT NULL,  -- Encrypted value
    description TEXT,
    provider TEXT,
    is_required BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_name ON api_keys(key_name);
CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON api_keys FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users read access" ON api_keys FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users update access" ON api_keys FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_api_keys_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER api_keys_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION update_api_keys_updated_at();

INSERT INTO api_keys (key_name, key_value, description, provider, is_required)
VALUES 
    ('supabase_anon_key', '', 'Supabase anonymous key (auto-generated)', 'Supabase', true),
    ('supabase_service_role_key', '', 'Supabase service role key (auto-generated)', 'Supabase', true),
    ('backend_admin_api_key', '', 'Backend admin API key (auto-generated)', 'AetherArena', true)
ON CONFLICT (key_name) DO NOTHING;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON user_settings, user_preferences, api_keys TO anon, authenticated, service_role;

-- ============================================================================
-- REALTIME
-- ============================================================================
ALTER PUBLICATION supabase_realtime ADD TABLE user_preferences;
