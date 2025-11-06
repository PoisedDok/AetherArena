-- Migration: Add indexes for SessionManager ID format
-- Author: Aether Architecture Team
-- Date: 2025-11-05
-- Description: Adds indexes for efficient querying of SessionManager IDs

-- ============================================================================
-- Messages Table Indexes
-- ============================================================================

-- Index for chat-level message queries (already exists, but verify)
-- This supports: SELECT * FROM messages WHERE chat_id = 'uuid' ORDER BY id
CREATE INDEX IF NOT EXISTS idx_messages_chat_id 
ON messages(chat_id);

-- Index for SessionManager ID prefix queries
-- This supports: SELECT * FROM messages WHERE id LIKE 'a0d6fa98_%'
CREATE INDEX IF NOT EXISTS idx_messages_id_prefix 
ON messages(id text_pattern_ops);

-- Index for message ordering within a chat
-- This supports efficient chronological queries
CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp 
ON messages(chat_id, created_at DESC);

-- Composite index for chat + id pattern
-- This supports: SELECT * FROM messages WHERE chat_id = 'uuid' AND id LIKE 'prefix%'
CREATE INDEX IF NOT EXISTS idx_messages_chat_id_pattern 
ON messages(chat_id, id text_pattern_ops);

-- ============================================================================
-- Artifacts Table Indexes
-- ============================================================================

-- Index for artifact-to-message linkage (foreign key should already have this)
CREATE INDEX IF NOT EXISTS idx_artifacts_message_id 
ON artifacts(message_id);

-- Index for SessionManager artifact ID prefix queries
CREATE INDEX IF NOT EXISTS idx_artifacts_id_prefix 
ON artifacts(id text_pattern_ops);

-- Index for chat-level artifact queries
CREATE INDEX IF NOT EXISTS idx_artifacts_chat_id 
ON artifacts(chat_id);

-- Composite index for message artifacts
-- This supports: SELECT * FROM artifacts WHERE message_id = 'id' ORDER BY created_at
CREATE INDEX IF NOT EXISTS idx_artifacts_message_timestamp 
ON artifacts(message_id, created_at ASC);

-- ============================================================================
-- Chats Table Indexes
-- ============================================================================

-- Index for chat ordering (most recent first)
CREATE INDEX IF NOT EXISTS idx_chats_updated_at 
ON chats(updated_at DESC);

-- Index for chat title search
CREATE INDEX IF NOT EXISTS idx_chats_title 
ON chats(title);

-- ============================================================================
-- Performance Analysis
-- ============================================================================

-- Example query patterns and how indexes help:

-- 1. Get all messages for a chat (uses idx_messages_chat_id)
-- SELECT * FROM messages WHERE chat_id = 'a0d6fa98-fc40-4f38-912a-0f6c25c96dcd';

-- 2. Get messages by SessionManager ID prefix (uses idx_messages_id_prefix)
-- SELECT * FROM messages WHERE id LIKE 'a0d6fa98_%';

-- 3. Get messages in chronological order (uses idx_messages_chat_timestamp)
-- SELECT * FROM messages WHERE chat_id = '...' ORDER BY created_at DESC;

-- 4. Get artifacts for a message (uses idx_artifacts_message_id)
-- SELECT * FROM artifacts WHERE message_id = 'a0d6fa98_000002_AM';

-- 5. Get all artifacts in a chat (uses idx_artifacts_chat_id)
-- SELECT * FROM artifacts WHERE chat_id = 'a0d6fa98-fc40-4f38-912a-0f6c25c96dcd';

-- 6. Get recent chats (uses idx_chats_updated_at)
-- SELECT * FROM chats ORDER BY updated_at DESC LIMIT 50;

-- ============================================================================
-- Verification Queries
-- ============================================================================

-- Check that indexes were created
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename IN ('messages', 'artifacts', 'chats')
ORDER BY tablename, indexname;

-- Analyze index usage (run after some queries)
-- SELECT * FROM pg_stat_user_indexes WHERE schemaname = 'public';

