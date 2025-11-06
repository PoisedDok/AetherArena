-- PostgreSQL Schema for Aether Chat System
-- Single source of truth for chats, messages, artifacts
-- Production-ready with constraints, indexes, CASCADE deletes

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Chats table: Top-level conversation containers
CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL DEFAULT 'New Chat',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chats_title_not_empty CHECK (LENGTH(TRIM(title)) > 0)
);

-- Index for sidebar ordering (most recently updated first)
CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC);

-- Messages table: All user/assistant interactions
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- LLM tracking fields
    llm_model VARCHAR(100),
    llm_provider VARCHAR(50),
    tokens_used INTEGER CHECK (tokens_used >= 0),
    correlation_id UUID,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for message retrieval
CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);

-- Artifacts table: Generated outputs linked to chats and messages
CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    
    -- Frontend compatibility fields
    artifact_id VARCHAR(100),
    
    -- Content fields
    type VARCHAR(20) NOT NULL CHECK (type IN ('code', 'html', 'output', 'file', 'text', 'markdown', 'json')),
    filename VARCHAR(255),
    content TEXT,
    language VARCHAR(50),
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT artifacts_content_not_empty CHECK (content IS NULL OR LENGTH(TRIM(content)) > 0)
);

-- Indexes for artifact retrieval
CREATE INDEX IF NOT EXISTS idx_artifacts_chat_id ON artifacts(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_message_id ON artifacts(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_id ON artifacts(artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);

-- Full-text search on artifact content
CREATE INDEX IF NOT EXISTS idx_artifacts_content_search ON artifacts USING GIN (to_tsvector('english', content));

-- Trigger to auto-update chat.updated_at when messages added
CREATE OR REPLACE FUNCTION update_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chats SET updated_at = NOW() WHERE id = NEW.chat_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_chat_on_message
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_chat_timestamp();

CREATE TRIGGER trigger_update_chat_on_artifact
    AFTER INSERT ON artifacts
    FOR EACH ROW
    EXECUTE FUNCTION update_chat_timestamp();

-- View for chat list with metadata (for sidebar)
CREATE OR REPLACE VIEW chat_list AS
SELECT 
    c.id,
    c.title,
    c.created_at,
    c.updated_at,
    COUNT(m.id) AS message_count,
    MAX(m.timestamp) AS last_message_at
FROM chats c
LEFT JOIN messages m ON c.id = m.chat_id
GROUP BY c.id, c.title, c.created_at, c.updated_at
ORDER BY c.updated_at DESC;

-- View for messages with LLM metadata
CREATE OR REPLACE VIEW messages_with_metadata AS
SELECT 
    m.id,
    m.chat_id,
    m.role,
    m.content,
    m.timestamp,
    m.llm_model,
    m.llm_provider,
    m.tokens_used,
    m.correlation_id,
    m.created_at,
    c.title AS chat_title
FROM messages m
JOIN chats c ON m.chat_id = c.id
ORDER BY m.timestamp;

-- Comment documentation
COMMENT ON TABLE chats IS 'Top-level conversation containers';
COMMENT ON TABLE messages IS 'All user and assistant messages with LLM tracking';
COMMENT ON TABLE artifacts IS 'Generated outputs (code, files, etc) linked to chats and messages';
COMMENT ON COLUMN messages.correlation_id IS 'Links user request to assistant response for traceability';
COMMENT ON COLUMN messages.llm_model IS 'Model used (e.g., gpt-4, claude-3-sonnet)';
COMMENT ON COLUMN messages.llm_provider IS 'Provider (e.g., openai, anthropic)';
COMMENT ON COLUMN artifacts.artifact_id IS 'Frontend-generated ID for compatibility';
COMMENT ON COLUMN artifacts.message_id IS 'Optional link to message that created this artifact';

