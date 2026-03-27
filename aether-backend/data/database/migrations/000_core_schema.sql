-- ============================================================================
-- Consolidated Migration: Core Schema
-- ============================================================================
-- Purpose: Core tables for chats, messages, artifacts, and trail execution hierarchy.
-- Version: 3.0.0 (Consolidated from 000, 002, 008, 015, 017-023, 036, 039)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- CHATS
-- ============================================================================
CREATE TABLE IF NOT EXISTS chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL DEFAULT 'New Chat',
    description TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    archived BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chats_title_not_empty CHECK (LENGTH(TRIM(title)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_chats_updated_at ON chats(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(created_at DESC);

-- ============================================================================
-- MESSAGES (requires group_id FK, but groups requires messages FK)
-- We define messages first without group_id, then add it later.
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sequence_in_chat INTEGER NOT NULL,
    llm_model VARCHAR(100),
    llm_provider VARCHAR(50),
    tokens_used INTEGER CHECK (tokens_used >= 0),
    correlation_id UUID,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT messages_unique_sequence UNIQUE (chat_id, sequence_in_chat)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_timeline_sequence ON messages(chat_id, sequence_in_chat);
CREATE INDEX IF NOT EXISTS idx_chat_timeline_chat_timestamp ON messages(chat_id, timestamp DESC);

-- ============================================================================
-- GROUPS
-- ============================================================================
CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_message TEXT NOT NULL,
    agent_message TEXT NOT NULL,
    sequence_number INT NOT NULL,
    frontend_id VARCHAR(255),
    backend_id VARCHAR(255),
    correlation_id VARCHAR(255),
    user_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    agent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT groups_sequence_positive CHECK (sequence_number > 0),
    CONSTRAINT groups_unique_sequence UNIQUE (chat_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_groups_chat_id ON groups(chat_id);
CREATE INDEX IF NOT EXISTS idx_groups_sequence ON groups(chat_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_groups_created ON groups(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_groups_backend_id ON groups(backend_id) WHERE backend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_user_message ON groups(user_message_id) WHERE user_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_agent_message ON groups(agent_message_id) WHERE agent_message_id IS NOT NULL;

-- Link messages to groups now that groups table exists
ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_group_id ON messages(group_id) WHERE group_id IS NOT NULL;

-- ============================================================================
-- SUBGROUPS
-- ============================================================================
CREATE TABLE IF NOT EXISTS subgroups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sequence_number INT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    execution_group VARCHAR(255),
    display_timestamp TIMESTAMPTZ,
    sequence_in_chat INT NOT NULL,
    chat_id_cache UUID,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT subgroups_status_valid CHECK (status IN ('pending', 'running', 'completed', 'error')),
    CONSTRAINT subgroups_sequence_positive CHECK (sequence_number > 0),
    CONSTRAINT subgroups_unique_sequence UNIQUE (group_id, sequence_number),
    CONSTRAINT subgroups_completion_time CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_subgroups_group_id ON subgroups(group_id);
CREATE INDEX IF NOT EXISTS idx_subgroups_status ON subgroups(status);
CREATE INDEX IF NOT EXISTS idx_subgroups_sequence ON subgroups(group_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_subgroups_execution ON subgroups(execution_group) WHERE execution_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subgroups_display_timestamp ON subgroups USING BRIN(display_timestamp);
CREATE INDEX IF NOT EXISTS idx_subgroups_created_at_brin ON subgroups USING BRIN(created_at);
CREATE INDEX IF NOT EXISTS idx_subgroups_display_timestamp_desc ON subgroups(display_timestamp DESC) WHERE display_timestamp IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subgroups_timeline_sequence ON subgroups(group_id, sequence_in_chat);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subgroups_unique_sequence ON subgroups(chat_id_cache, sequence_in_chat) WHERE chat_id_cache IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_subgroups_execution_unique ON subgroups(group_id, execution_group) WHERE execution_group IS NOT NULL;

-- ============================================================================
-- NODES
-- ============================================================================
CREATE TABLE IF NOT EXISTS nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subgroup_id UUID NOT NULL REFERENCES subgroups(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    sequence INT NOT NULL,
    clickable BOOLEAN NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    artifact_id TEXT,
    artifact_type TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT nodes_type_valid CHECK (type IN ('writing', 'executing', 'output')),
    CONSTRAINT nodes_sequence_valid CHECK (sequence IN (1, 2, 3)),
    CONSTRAINT nodes_status_valid CHECK (status IN ('pending', 'active', 'completed', 'error')),
    CONSTRAINT nodes_unique_sequence UNIQUE (subgroup_id, sequence),
    CONSTRAINT nodes_type_sequence_mapping CHECK (
        (type = 'writing' AND sequence = 1 AND clickable = true) OR
        (type = 'executing' AND sequence = 2 AND clickable = false) OR
        (type = 'output' AND sequence = 3 AND clickable = true)
    ),
    CONSTRAINT nodes_artifact_consistency CHECK (
        (type = 'executing' AND artifact_id IS NULL AND artifact_type IS NULL) OR
        (type IN ('writing', 'output'))
    ),
    CONSTRAINT nodes_completion_time CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
    CONSTRAINT nodes_duration_positive CHECK (duration_ms IS NULL OR duration_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_nodes_subgroup_id ON nodes(subgroup_id);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_sequence ON nodes(subgroup_id, sequence);
CREATE INDEX IF NOT EXISTS idx_nodes_artifact_id ON nodes(artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_artifact_type ON nodes(artifact_type) WHERE artifact_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_subgroup_artifact ON nodes(subgroup_id, artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_duration ON nodes(duration_ms) WHERE duration_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_active ON nodes(status, started_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_nodes_timing ON nodes(started_at, completed_at) WHERE started_at IS NOT NULL;

-- ============================================================================
-- ARTIFACTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    subgroup_id UUID REFERENCES subgroups(id) ON DELETE SET NULL,
    node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
    artifact_id VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('code', 'html', 'output', 'file', 'text', 'markdown', 'json', 'console')),
    filename VARCHAR(255),
    content TEXT,
    language VARCHAR(50),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT artifacts_content_not_empty CHECK (content IS NULL OR LENGTH(TRIM(content)) > 0),
    CONSTRAINT artifacts_unique_per_chat UNIQUE (chat_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_chat_id ON artifacts(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_message_id ON artifacts(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_id ON artifacts(artifact_id) WHERE artifact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_subgroup ON artifacts(subgroup_id) WHERE subgroup_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_node ON artifacts(node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_subgroup_type ON artifacts(subgroup_id, type) WHERE subgroup_id IS NOT NULL;

-- Full text search (text only, exclude binary)
CREATE INDEX IF NOT EXISTS idx_artifacts_content_search_text_only ON artifacts USING GIN (to_tsvector('english', content))
    WHERE (metadata->>'is_binary' IS NULL OR metadata->>'is_binary' = 'false') AND type NOT IN ('file') AND LENGTH(content) < 1000000 AND content IS NOT NULL;

-- ============================================================================
-- LEGACY TABLES (Deprecated but kept for backwards compat if needed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS trail_states (
    chat_id VARCHAR(255) PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trail_states_updated ON trail_states(updated_at DESC);

CREATE TABLE IF NOT EXISTS traceability_data (
    id VARCHAR(50) PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_traceability_data_updated ON traceability_data(updated_at DESC);

-- ============================================================================
-- CHAT REFERENCES
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_references (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    target_chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    reference_type VARCHAR(32) NOT NULL DEFAULT 'context' CHECK (
        reference_type IN ('context', 'memory', 'attachment', 'related')
    ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by VARCHAR(32) NOT NULL DEFAULT 'user' CHECK (
        created_by IN ('user', 'agent', 'system')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chat_references_unique UNIQUE (source_chat_id, target_chat_id, reference_type)
);

CREATE INDEX IF NOT EXISTS idx_chat_references_source ON chat_references(source_chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_references_target ON chat_references(target_chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_references_created_at ON chat_references(created_at DESC);

-- ============================================================================
-- TRIGGERS & FUNCTIONS
-- ============================================================================

-- Function: update_chat_timestamp
CREATE OR REPLACE FUNCTION update_chat_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chats SET updated_at = NOW() WHERE id = NEW.chat_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_chat_on_message
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_chat_timestamp();

CREATE TRIGGER trigger_update_chat_on_artifact
    AFTER INSERT ON artifacts
    FOR EACH ROW EXECUTE FUNCTION update_chat_timestamp();

-- Function: update_trail_timestamp
CREATE OR REPLACE FUNCTION update_trail_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_trail_timestamp
    BEFORE UPDATE ON trail_states
    FOR EACH ROW EXECUTE FUNCTION update_trail_timestamp();

-- Function: update_group_timestamp
CREATE OR REPLACE FUNCTION update_group_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_group_timestamp
    BEFORE UPDATE ON groups
    FOR EACH ROW EXECUTE FUNCTION update_group_timestamp();

-- Function: update_node_timestamp
CREATE OR REPLACE FUNCTION update_node_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_node_timestamp
    BEFORE UPDATE ON nodes
    FOR EACH ROW EXECUTE FUNCTION update_node_timestamp();

-- Function: get_next_chat_sequence
CREATE OR REPLACE FUNCTION get_next_chat_sequence(p_chat_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_seq INT;
  max_message_seq INT;
  max_subgroup_seq INT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    ('x' || substring(md5(p_chat_id::text) from 1 for 16))::bit(64)::bigint
  );
  
  SELECT COALESCE(MAX(sequence_in_chat), 0) INTO max_message_seq
  FROM messages 
  WHERE chat_id = p_chat_id;
  
  SELECT COALESCE(MAX(sg.sequence_in_chat), 0) INTO max_subgroup_seq
  FROM subgroups sg
  JOIN groups g ON sg.group_id = g.id
  WHERE g.chat_id = p_chat_id;
  
  next_seq := GREATEST(max_message_seq, max_subgroup_seq) + 1;
  RETURN next_seq;
END;
$$;

-- Function: auto_populate_subgroup_chat_id
CREATE OR REPLACE FUNCTION auto_populate_subgroup_chat_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.chat_id_cache IS NULL THEN
    SELECT chat_id INTO NEW.chat_id_cache
    FROM groups
    WHERE id = NEW.group_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_auto_populate_subgroup_chat_id
  BEFORE INSERT OR UPDATE ON subgroups
  FOR EACH ROW EXECUTE FUNCTION auto_populate_subgroup_chat_id();

-- Function: get_artifacts_with_execution_group
CREATE OR REPLACE FUNCTION get_artifacts_with_execution_group(
    p_chat_id UUID,
    p_type VARCHAR DEFAULT NULL,
    p_limit INT DEFAULT 1000,
    p_offset INT DEFAULT 0
)
RETURNS TABLE(
    id UUID,
    chat_id UUID,
    message_id UUID,
    artifact_id VARCHAR,
    type VARCHAR,
    filename VARCHAR,
    content TEXT,
    language VARCHAR,
    metadata JSONB,
    created_at TIMESTAMPTZ,
    subgroup_id UUID,
    node_id UUID,
    execution_group VARCHAR
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id, a.chat_id, a.message_id, a.artifact_id, a.type, a.filename, a.content,
        a.language, a.metadata, a.created_at, a.subgroup_id, a.node_id, s.execution_group
    FROM artifacts a
    LEFT JOIN subgroups s ON a.subgroup_id = s.id
    WHERE a.chat_id = p_chat_id AND (p_type IS NULL OR a.type = p_type)
    ORDER BY a.created_at DESC LIMIT p_limit OFFSET p_offset;
END;
$$;

-- Function: calculate_node_duration
CREATE OR REPLACE FUNCTION calculate_node_duration()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.completed_at IS NOT NULL AND NEW.started_at IS NOT NULL THEN
        NEW.duration_ms := EXTRACT(EPOCH FROM (NEW.completed_at - NEW.started_at)) * 1000;
    END IF;
    IF NEW.status = 'active' AND NEW.started_at IS NULL AND OLD.status != 'active' THEN
        NEW.started_at := NOW();
    END IF;
    IF NEW.status = 'completed' AND NEW.completed_at IS NULL AND OLD.status != 'completed' THEN
        NEW.completed_at := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_calculate_node_duration
    BEFORE UPDATE ON nodes
    FOR EACH ROW EXECUTE FUNCTION calculate_node_duration();

-- Function: validate_node_count
CREATE OR REPLACE FUNCTION validate_node_count()
RETURNS TRIGGER AS $$
DECLARE
    node_count INT;
BEGIN
    SELECT COUNT(*) INTO node_count FROM nodes WHERE subgroup_id = NEW.subgroup_id;
    IF node_count > 3 THEN
        RAISE WARNING 'Subgroup % has more than 3 nodes (count: %)', NEW.subgroup_id, node_count;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_validate_node_count
    AFTER INSERT ON nodes
    FOR EACH ROW EXECUTE FUNCTION validate_node_count();

-- Function: auto_link_agent_message_to_group
CREATE OR REPLACE FUNCTION auto_link_agent_message_to_group()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  matching_group_id UUID;
  linked_count INT;
BEGIN
  IF NEW.role != 'assistant' THEN RETURN NEW; END IF;
  
  SELECT id INTO matching_group_id FROM groups
  WHERE chat_id = NEW.chat_id AND agent_message_id IS NULL
    AND ((NEW.correlation_id IS NOT NULL AND correlation_id = NEW.correlation_id::text)
      OR (NEW.correlation_id IS NULL AND correlation_id IS NULL))
  ORDER BY created_at DESC LIMIT 1;
  
  IF matching_group_id IS NOT NULL THEN
    UPDATE groups SET agent_message_id = NEW.id WHERE id = matching_group_id;
    UPDATE subgroups SET display_timestamp = NOW() WHERE group_id = matching_group_id AND display_timestamp IS NULL;
    GET DIAGNOSTICS linked_count = ROW_COUNT;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_auto_link_agent_message
  AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.role = 'assistant') EXECUTE FUNCTION auto_link_agent_message_to_group();

-- Function: auto_set_display_timestamp
CREATE OR REPLACE FUNCTION auto_set_display_timestamp()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.display_timestamp = COALESCE(NEW.completed_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_auto_set_display_timestamp
  BEFORE UPDATE ON subgroups
  FOR EACH ROW WHEN (NEW.status = 'completed' AND OLD.status != 'completed') EXECUTE FUNCTION auto_set_display_timestamp();

-- Function: broadcast_trail_changes
CREATE OR REPLACE FUNCTION broadcast_trail_changes()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public, realtime
LANGUAGE plpgsql
AS $$
DECLARE
  chat_uuid UUID;
  topic_name TEXT;
BEGIN
  SELECT g.chat_id INTO chat_uuid FROM groups g WHERE g.id = COALESCE(NEW.group_id, OLD.group_id);
  IF chat_uuid IS NOT NULL THEN
    topic_name := 'chat:' || chat_uuid::text || ':trails';
    PERFORM realtime.broadcast_changes(topic_name, TG_OP, TG_OP, TG_TABLE_NAME, TG_TABLE_SCHEMA, NEW, OLD);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trigger_broadcast_subgroup_changes
  AFTER INSERT OR UPDATE OR DELETE ON subgroups
  FOR EACH ROW EXECUTE FUNCTION broadcast_trail_changes();

-- Function: reload_schema_cache
CREATE OR REPLACE FUNCTION public.reload_schema_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM pg_notify('pgrst', 'reload schema');
END;
$$;

-- ============================================================================
-- VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW chat_list AS
SELECT 
    c.id, c.title, c.description, c.metadata, c.archived,
    c.created_at, c.updated_at,
    COUNT(m.id) AS message_count,
    MAX(m.timestamp) AS last_message_at
FROM chats c
LEFT JOIN messages m ON c.id = m.chat_id
GROUP BY c.id, c.title, c.description, c.metadata, c.archived, c.created_at, c.updated_at
ORDER BY c.updated_at DESC;

CREATE OR REPLACE VIEW messages_with_metadata AS
SELECT 
    m.id, m.chat_id, m.group_id, m.role, m.content, m.timestamp, m.sequence_in_chat,
    m.llm_model, m.llm_provider, m.tokens_used, m.correlation_id, m.metadata, m.created_at,
    c.title AS chat_title
FROM messages m
JOIN chats c ON m.chat_id = c.id
ORDER BY m.timestamp;

CREATE OR REPLACE VIEW trail_hierarchy AS
SELECT 
    c.id AS chat_id, c.title AS chat_title,
    g.id AS group_id, g.sequence_number AS group_sequence, g.user_message, g.agent_message, g.created_at AS group_created_at,
    s.id AS subgroup_id, s.sequence_number AS subgroup_sequence, s.status AS subgroup_status, s.execution_group,
    COUNT(n.id) AS node_count,
    jsonb_agg(jsonb_build_object('node_id', n.id, 'type', n.type, 'sequence', n.sequence, 'clickable', n.clickable, 'status', n.status) ORDER BY n.sequence) AS nodes
FROM chats c
JOIN groups g ON c.id = g.chat_id
JOIN subgroups s ON g.id = s.group_id
LEFT JOIN nodes n ON s.id = n.subgroup_id
GROUP BY c.id, c.title, g.id, g.sequence_number, g.user_message, g.agent_message, g.created_at, s.id, s.sequence_number, s.status, s.execution_group
ORDER BY c.id, g.sequence_number, s.sequence_number;

CREATE OR REPLACE VIEW subgroup_artifacts AS
SELECT 
    s.id AS subgroup_id, s.group_id, s.sequence_number AS subgroup_sequence, g.chat_id,
    COUNT(a.id) AS artifact_count,
    jsonb_agg(jsonb_build_object('artifact_id', a.artifact_id, 'type', a.type, 'filename', a.filename, 'node_id', a.node_id, 'created_at', a.created_at) ORDER BY a.type) FILTER (WHERE a.id IS NOT NULL) AS artifacts
FROM subgroups s
JOIN groups g ON s.group_id = g.id
LEFT JOIN artifacts a ON s.id = a.subgroup_id
WHERE a.type IN ('code', 'output', 'html', 'markdown', 'json', 'console')
GROUP BY s.id, s.group_id, s.sequence_number, g.chat_id
ORDER BY g.chat_id, s.sequence_number;

CREATE OR REPLACE VIEW trail_stats AS
SELECT 
    c.id AS chat_id, c.title,
    COUNT(DISTINCT g.id) AS group_count,
    COUNT(DISTINCT s.id) AS subgroup_count,
    COUNT(n.id) AS node_count,
    COUNT(a.id) AS artifact_count,
    MAX(g.created_at) AS last_group_created
FROM chats c
LEFT JOIN groups g ON c.id = g.chat_id
LEFT JOIN subgroups s ON g.id = s.group_id
LEFT JOIN nodes n ON s.id = n.subgroup_id
LEFT JOIN artifacts a ON s.id = a.subgroup_id
GROUP BY c.id, c.title
ORDER BY last_group_created DESC NULLS LAST;

CREATE OR REPLACE VIEW chat_timeline_view AS
SELECT 
  'message'::text AS event_type, m.id AS event_id, m.chat_id, m.sequence_in_chat AS sequence,
  m.timestamp AS event_timestamp, m.role, m.id AS message_id,
  NULL::uuid AS group_id, NULL::uuid AS subgroup_id, NULL::integer AS subgroup_sequence, m.content
FROM messages m
UNION ALL
SELECT 
  'trail'::text AS event_type, sg.id AS event_id, g.chat_id, sg.sequence_in_chat AS sequence,
  COALESCE(sg.completed_at, sg.created_at) AS event_timestamp, NULL::character varying AS role,
  NULL::uuid AS message_id, g.id AS group_id, sg.id AS subgroup_id, sg.sequence_number AS subgroup_sequence, NULL::text AS content
FROM subgroups sg
JOIN groups g ON sg.group_id = g.id
WHERE sg.status = 'completed';

CREATE OR REPLACE VIEW messages_group_counts AS
SELECT chat_id, COUNT(*) AS count FROM messages GROUP BY chat_id;

CREATE OR REPLACE VIEW artifacts_group_counts AS
SELECT chat_id, COUNT(*) AS count FROM artifacts GROUP BY chat_id;

-- ============================================================================
-- GRANTS & REALTIME
-- ============================================================================
GRANT ALL ON chats, messages, artifacts, groups, subgroups, nodes, trail_states, traceability_data, chat_references TO anon, authenticated, service_role;
GRANT SELECT ON chat_list, messages_with_metadata, trail_hierarchy, subgroup_artifacts, trail_stats, chat_timeline_view, messages_group_counts, artifacts_group_counts TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_next_chat_sequence(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_artifacts_with_execution_group(UUID, VARCHAR, INT, INT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reload_schema_cache() TO service_role, supabase_admin;

ALTER PUBLICATION supabase_realtime ADD TABLE chats, messages, artifacts, trail_states, groups, subgroups, nodes;
