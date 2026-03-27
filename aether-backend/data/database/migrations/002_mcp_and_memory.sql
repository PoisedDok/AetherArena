-- ============================================================================
-- Consolidated Migration: MCP & Semantic Memory
-- ============================================================================
-- Purpose: MCP server management, and Knowledge Graph (Global Memories).
-- Version: 3.0.0 (Consolidated from 003, 016, 004)
-- Database: aether
-- User: supabase_admin
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- MCP SERVERS & TOOLS
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    server_type VARCHAR(50) NOT NULL CHECK (server_type IN ('local', 'remote')),
    config JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'error', 'starting', 'stopping')),
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_health_check TIMESTAMPTZ,
    health_status VARCHAR(50) CHECK (health_status IN ('healthy', 'unhealthy', 'unknown')),
    enabled BOOLEAN DEFAULT true,
    sandbox_enabled BOOLEAN DEFAULT true,
    resource_limits JSONB DEFAULT '{"max_memory_mb": 512, "max_cpu_percent": 50, "max_execution_time_seconds": 300}'::jsonb,
    total_tool_calls INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    auto_start BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_type ON mcp_servers(server_type);

CREATE TABLE IF NOT EXISTS mcp_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    description TEXT,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    openai_schema JSONB NOT NULL,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_id ON mcp_tools(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_name ON mcp_tools(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_enabled ON mcp_tools(enabled);

CREATE TABLE IF NOT EXISTS mcp_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    arguments JSONB NOT NULL,
    result TEXT,
    status VARCHAR(50) NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cancelled')),
    error_message TEXT,
    executed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    duration_ms INTEGER,
    execution_context JSONB,
    sandboxed BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_mcp_executions_server_id ON mcp_executions(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_executions_executed_at ON mcp_executions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_executions_status ON mcp_executions(status);

-- ============================================================================
-- MCP PERSISTENT MEMORY
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_memory_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(500) UNIQUE NOT NULL,
    entity_type VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(name, '') || ' ' || coalesce(entity_type, ''))) STORED,
    embedding vector(1536)
);

CREATE TABLE IF NOT EXISTS mcp_memory_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    observation TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', observation)) STORED,
    embedding vector(1536)
);

CREATE TABLE IF NOT EXISTS mcp_memory_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    to_entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    relation_type VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb,
    UNIQUE(from_entity_id, to_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON mcp_memory_entities USING btree(name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON mcp_memory_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_memory_entities_updated ON mcp_memory_entities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_entities_search ON mcp_memory_entities USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_memory_observations_search ON mcp_memory_observations USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_memory_entities_embedding ON mcp_memory_entities USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memory_observations_embedding ON mcp_memory_observations USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memory_observations_entity ON mcp_memory_observations(entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON mcp_memory_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON mcp_memory_relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON mcp_memory_relations(relation_type);

-- ============================================================================
-- GLOBAL MEMORIES (Knowledge Graph + pgvector 384d)
-- ============================================================================
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT NOT NULL,
    memory_type VARCHAR(50) NOT NULL,
    importance_score FLOAT NOT NULL DEFAULT 0.5,
    source_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    embedding VECTOR(384),
    extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    access_count INTEGER DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_by VARCHAR(50) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    CHECK (importance_score >= 0 AND importance_score <= 1),
    CHECK (memory_type IN ('fact', 'decision', 'preference', 'action_item', 'insight', 'reference')),
    CHECK (created_by IN ('agent', 'user', 'system'))
);

CREATE TABLE IF NOT EXISTS memory_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    tag VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(memory_id, tag)
);

CREATE TABLE IF NOT EXISTS memory_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    related_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    relation_type VARCHAR(50) NOT NULL,
    strength FLOAT NOT NULL DEFAULT 0.5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(memory_id, related_memory_id),
    CHECK (memory_id != related_memory_id),
    CHECK (strength >= 0 AND strength <= 1),
    CHECK (relation_type IN ('contradicts', 'supports', 'supersedes', 'related_to', 'expands_on'))
);

CREATE INDEX IF NOT EXISTS idx_memories_embedding_hnsw ON memories USING hnsw (embedding vector_ip_ops);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance_score DESC);
CREATE INDEX IF NOT EXISTS idx_memories_extracted ON memories(extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(last_accessed_at DESC) WHERE last_accessed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_source_chat ON memories(source_chat_id) WHERE source_chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_created_by ON memories(created_by);
CREATE INDEX IF NOT EXISTS idx_memories_content_search ON memories USING GIN (to_tsvector('english', content));

CREATE INDEX IF NOT EXISTS idx_memory_tags_memory ON memory_tags(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);

CREATE INDEX IF NOT EXISTS idx_memory_relations_memory ON memory_relations(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_related ON memory_relations(related_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation_type);

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_mcp_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = CURRENT_TIMESTAMP; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER update_mcp_servers_timestamp BEFORE UPDATE ON mcp_servers FOR EACH ROW EXECUTE FUNCTION update_mcp_timestamp();
CREATE TRIGGER update_mcp_tools_timestamp BEFORE UPDATE ON mcp_tools FOR EACH ROW EXECUTE FUNCTION update_mcp_timestamp();
CREATE TRIGGER update_memory_entity_timestamp BEFORE UPDATE ON mcp_memory_entities FOR EACH ROW EXECUTE FUNCTION update_mcp_timestamp();

CREATE OR REPLACE FUNCTION update_memory_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trigger_update_memory_timestamp BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION update_memory_timestamp();

CREATE OR REPLACE FUNCTION search_memory_entities_text(query_text TEXT, max_results INT DEFAULT 10) RETURNS TABLE(id UUID, name VARCHAR, entity_type VARCHAR, rank REAL, observation_count BIGINT) AS $$ BEGIN RETURN QUERY SELECT e.id, e.name, e.entity_type, ts_rank(e.search_vector, plainto_tsquery('english', query_text)) as rank, COUNT(o.id) as observation_count FROM mcp_memory_entities e LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id WHERE e.search_vector @@ plainto_tsquery('english', query_text) GROUP BY e.id, e.name, e.entity_type, e.search_vector ORDER BY rank DESC LIMIT max_results; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION search_memory_entities_semantic(query_embedding vector, similarity_threshold DOUBLE PRECISION DEFAULT 0.7, max_results INT DEFAULT 10) RETURNS TABLE(id UUID, name VARCHAR, entity_type VARCHAR, similarity DOUBLE PRECISION, observation_count BIGINT) AS $$ BEGIN RETURN QUERY SELECT e.id, e.name, e.entity_type, 1 - (e.embedding <=> query_embedding) as similarity, COUNT(o.id) as observation_count FROM mcp_memory_entities e LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id WHERE e.embedding IS NOT NULL AND 1 - (e.embedding <=> query_embedding) >= similarity_threshold GROUP BY e.id, e.name, e.entity_type, e.embedding ORDER BY e.embedding <=> query_embedding LIMIT max_results; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION search_memories(query_embedding VECTOR(384), match_threshold FLOAT DEFAULT 0.5, match_count INT DEFAULT 10) RETURNS TABLE (id UUID, content TEXT, memory_type VARCHAR, importance_score FLOAT, similarity FLOAT) AS $$ BEGIN RETURN QUERY SELECT m.id, m.content, m.memory_type, m.importance_score, 1 - (m.embedding <#> query_embedding) AS similarity FROM memories m WHERE m.embedding IS NOT NULL AND 1 - (m.embedding <#> query_embedding) > match_threshold ORDER BY m.embedding <#> query_embedding LIMIT match_count; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION search_memories_hybrid(query_text TEXT, query_embedding VECTOR(384), match_threshold FLOAT DEFAULT 0.5, match_count INT DEFAULT 10, vector_weight FLOAT DEFAULT 0.7, keyword_weight FLOAT DEFAULT 0.3) RETURNS TABLE (id UUID, content TEXT, memory_type VARCHAR, importance_score FLOAT, combined_score FLOAT) AS $$ BEGIN RETURN QUERY WITH vector_results AS (SELECT m.id, m.content, m.memory_type, m.importance_score, 1 - (m.embedding <#> query_embedding) AS similarity FROM memories m WHERE m.embedding IS NOT NULL), keyword_results AS (SELECT m.id, ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', query_text)) AS rank FROM memories m WHERE to_tsvector('english', m.content) @@ plainto_tsquery('english', query_text)) SELECT v.id, v.content, v.memory_type, v.importance_score, (v.similarity * vector_weight + COALESCE(k.rank, 0) * keyword_weight) AS combined_score FROM vector_results v LEFT JOIN keyword_results k ON v.id = k.id WHERE v.similarity > match_threshold OR k.rank IS NOT NULL ORDER BY combined_score DESC LIMIT match_count; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION consolidate_similar_memories(similarity_threshold FLOAT DEFAULT 0.95) RETURNS TABLE (merged_count INTEGER, kept_memory_id UUID, removed_memory_ids UUID[]) AS $$ DECLARE memory_record RECORD; similar_memory RECORD; merged INTEGER := 0; removed_ids UUID[]; BEGIN FOR memory_record IN SELECT id, content, embedding, memory_type, importance_score FROM memories WHERE embedding IS NOT NULL ORDER BY importance_score DESC, extracted_at DESC LOOP removed_ids := ARRAY[]::UUID[]; FOR similar_memory IN SELECT id, content, importance_score FROM memories WHERE id != memory_record.id AND memory_type = memory_record.memory_type AND embedding IS NOT NULL AND 1 - (embedding <#> memory_record.embedding) > similarity_threshold LOOP INSERT INTO memory_tags (memory_id, tag) SELECT memory_record.id, tag FROM memory_tags WHERE memory_id = similar_memory.id ON CONFLICT (memory_id, tag) DO NOTHING; UPDATE memories SET importance_score = LEAST(1.0, importance_score + (similar_memory.importance_score * 0.1)), updated_at = NOW() WHERE id = memory_record.id; DELETE FROM memories WHERE id = similar_memory.id; removed_ids := array_append(removed_ids, similar_memory.id); merged := merged + 1; END LOOP; IF array_length(removed_ids, 1) > 0 THEN RETURN QUERY SELECT merged, memory_record.id, removed_ids; END IF; END LOOP; RETURN; END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION update_memory_access_stats(p_memory_id UUID) RETURNS VOID AS $$ BEGIN UPDATE memories SET last_accessed_at = NOW(), access_count = access_count + 1, importance_score = LEAST(1.0, importance_score + 0.01) WHERE id = p_memory_id; END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_related_memories(p_memory_id UUID, p_relation_types VARCHAR[] DEFAULT NULL, p_max_depth INT DEFAULT 2) RETURNS TABLE (memory_id UUID, content TEXT, relation_type VARCHAR, depth INT, path UUID[]) AS $$ BEGIN RETURN QUERY WITH RECURSIVE memory_graph AS (SELECT mr.related_memory_id AS memory_id, m.content, mr.relation_type, 1 AS depth, ARRAY[p_memory_id, mr.related_memory_id] AS path FROM memory_relations mr JOIN memories m ON mr.related_memory_id = m.id WHERE mr.memory_id = p_memory_id AND (p_relation_types IS NULL OR mr.relation_type = ANY(p_relation_types)) UNION ALL SELECT mr.related_memory_id, m.content, mr.relation_type, mg.depth + 1, mg.path || mr.related_memory_id FROM memory_relations mr JOIN memories m ON mr.related_memory_id = m.id JOIN memory_graph mg ON mr.memory_id = mg.memory_id WHERE mg.depth < p_max_depth AND NOT (mr.related_memory_id = ANY(mg.path)) AND (p_relation_types IS NULL OR mr.relation_type = ANY(p_relation_types))) SELECT * FROM memory_graph ORDER BY depth, memory_id; END; $$ LANGUAGE plpgsql;

-- ============================================================================
-- VIEWS
-- ============================================================================
CREATE OR REPLACE VIEW mcp_server_stats AS SELECT s.id, s.name, s.display_name, s.status, s.health_status, COUNT(DISTINCT t.id) as tool_count, COUNT(e.id) as total_executions, COUNT(CASE WHEN e.status = 'success' THEN 1 END) as successful_executions, COUNT(CASE WHEN e.status = 'error' THEN 1 END) as failed_executions, MAX(e.executed_at) as last_execution_at, AVG(e.duration_ms) as avg_execution_time_ms FROM mcp_servers s LEFT JOIN mcp_tools t ON s.id = t.server_id LEFT JOIN mcp_executions e ON s.id = e.server_id GROUP BY s.id, s.name, s.display_name, s.status, s.health_status;
CREATE OR REPLACE VIEW mcp_memory_stats AS SELECT COUNT(DISTINCT e.id) as total_entities, COUNT(DISTINCT e.entity_type) as unique_types, COUNT(o.id) as total_observations, COUNT(r.id) as total_relations, MAX(e.updated_at) as last_updated FROM mcp_memory_entities e LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id LEFT JOIN mcp_memory_relations r ON e.id = r.from_entity_id OR e.id = r.to_entity_id;
CREATE OR REPLACE VIEW memories_with_tags AS SELECT m.id, m.content, m.memory_type, m.importance_score, m.source_chat_id, m.extracted_at, m.last_accessed_at, m.access_count, m.created_by, ARRAY_AGG(mt.tag ORDER BY mt.tag) FILTER (WHERE mt.tag IS NOT NULL) AS tags FROM memories m LEFT JOIN memory_tags mt ON m.id = mt.memory_id GROUP BY m.id, m.content, m.memory_type, m.importance_score, m.source_chat_id, m.extracted_at, m.last_accessed_at, m.access_count, m.created_by;

-- ============================================================================
-- GRANTS
-- ============================================================================
GRANT ALL ON mcp_servers, mcp_tools, mcp_executions, mcp_memory_entities, mcp_memory_observations, mcp_memory_relations, memories, memory_tags, memory_relations TO anon, authenticated, service_role;
GRANT SELECT ON mcp_server_stats, mcp_memory_stats, memories_with_tags TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION search_memory_entities_text(TEXT, INT), search_memory_entities_semantic(vector, DOUBLE PRECISION, INT), search_memories(VECTOR, FLOAT, INT), search_memories_hybrid(TEXT, VECTOR, FLOAT, INT, FLOAT, FLOAT), consolidate_similar_memories(FLOAT), update_memory_access_stats(UUID), get_related_memories(UUID, VARCHAR[], INT) TO anon, authenticated, service_role;
