-- MCP Server Management Schema
-- Secure, production-ready schema for managing Model Context Protocol servers

-- MCP Servers Table
CREATE TABLE IF NOT EXISTS mcp_servers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    description TEXT,
    server_type VARCHAR(50) NOT NULL CHECK (server_type IN ('local', 'remote')),
    config JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'error', 'starting', 'stopping')),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_health_check TIMESTAMP WITH TIME ZONE,
    health_status VARCHAR(50) CHECK (health_status IN ('healthy', 'unhealthy', 'unknown')),
    enabled BOOLEAN DEFAULT true,
    
    -- Security metadata
    sandbox_enabled BOOLEAN DEFAULT true,
    resource_limits JSONB DEFAULT '{"max_memory_mb": 512, "max_cpu_percent": 50, "max_execution_time_seconds": 300}'::jsonb,
    
    -- Usage tracking
    total_tool_calls INTEGER DEFAULT 0,
    total_errors INTEGER DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE
);

-- MCP Tools Table (cached tool definitions from servers)
CREATE TABLE IF NOT EXISTS mcp_tools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    description TEXT,
    parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
    openai_schema JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(server_id, tool_name)
);

-- MCP Execution History
CREATE TABLE IF NOT EXISTS mcp_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    tool_name VARCHAR(255) NOT NULL,
    arguments JSONB NOT NULL,
    result TEXT,
    status VARCHAR(50) NOT NULL CHECK (status IN ('success', 'error', 'timeout', 'cancelled')),
    error_message TEXT,
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    duration_ms INTEGER,
    
    -- Security audit
    execution_context JSONB,
    sandboxed BOOLEAN DEFAULT true
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_mcp_servers_status ON mcp_servers(status);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_type ON mcp_servers(server_type);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_id ON mcp_tools(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_name ON mcp_tools(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcp_executions_server_id ON mcp_executions(server_id);
CREATE INDEX IF NOT EXISTS idx_mcp_executions_executed_at ON mcp_executions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_executions_status ON mcp_executions(status);

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_mcp_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_mcp_servers_timestamp ON mcp_servers;
CREATE TRIGGER update_mcp_servers_timestamp
    BEFORE UPDATE ON mcp_servers
    FOR EACH ROW
    EXECUTE FUNCTION update_mcp_timestamp();

DROP TRIGGER IF EXISTS update_mcp_tools_timestamp ON mcp_tools;
CREATE TRIGGER update_mcp_tools_timestamp
    BEFORE UPDATE ON mcp_tools
    FOR EACH ROW
    EXECUTE FUNCTION update_mcp_timestamp();

-- View for server statistics
CREATE OR REPLACE VIEW mcp_server_stats AS
SELECT 
    s.id,
    s.name,
    s.display_name,
    s.status,
    s.health_status,
    COUNT(DISTINCT t.id) as tool_count,
    COUNT(e.id) as total_executions,
    COUNT(CASE WHEN e.status = 'success' THEN 1 END) as successful_executions,
    COUNT(CASE WHEN e.status = 'error' THEN 1 END) as failed_executions,
    MAX(e.executed_at) as last_execution_at,
    AVG(e.duration_ms) as avg_execution_time_ms
FROM mcp_servers s
LEFT JOIN mcp_tools t ON s.id = t.server_id
LEFT JOIN mcp_executions e ON s.id = e.server_id
GROUP BY s.id, s.name, s.display_name, s.status, s.health_status;

COMMENT ON TABLE mcp_servers IS 'Registered MCP servers with security isolation';
COMMENT ON TABLE mcp_tools IS 'Tool definitions cached from MCP servers';
COMMENT ON TABLE mcp_executions IS 'Execution audit log for security and debugging';
COMMENT ON VIEW mcp_server_stats IS 'Aggregated statistics per MCP server';

-- =============================================================================
-- MCP Persistent Memory System
-- Knowledge graph with entities, relations, semantic search via pgvector
-- =============================================================================

-- Memory Entities (nodes in knowledge graph)
CREATE TABLE IF NOT EXISTS mcp_memory_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(500) UNIQUE NOT NULL,
    entity_type VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Full text search column
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(name, '') || ' ' || coalesce(entity_type, ''))
    ) STORED,
    
    -- pgvector embedding for semantic search (1536 dimensions for OpenAI ada-002)
    embedding vector(1536)
);

-- Memory Observations (facts/attributes about entities)
CREATE TABLE IF NOT EXISTS mcp_memory_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    observation TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Metadata for context
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Full text search for observations
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', observation)
    ) STORED,
    
    -- Optional embedding for observation-level semantic search
    embedding vector(1536)
);

-- Memory Relations (edges in knowledge graph)
CREATE TABLE IF NOT EXISTS mcp_memory_relations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    to_entity_id UUID NOT NULL REFERENCES mcp_memory_entities(id) ON DELETE CASCADE,
    relation_type VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Prevent duplicate relations
    UNIQUE(from_entity_id, to_entity_id, relation_type)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON mcp_memory_entities USING btree(name);
CREATE INDEX IF NOT EXISTS idx_memory_entities_type ON mcp_memory_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_memory_entities_updated ON mcp_memory_entities(updated_at DESC);

-- Full text search indexes (GIN index for fast keyword search)
CREATE INDEX IF NOT EXISTS idx_memory_entities_search ON mcp_memory_entities USING gin(search_vector);
CREATE INDEX IF NOT EXISTS idx_memory_observations_search ON mcp_memory_observations USING gin(search_vector);

-- Vector similarity search indexes (HNSW for fast approximate nearest neighbor)
CREATE INDEX IF NOT EXISTS idx_memory_entities_embedding ON mcp_memory_entities 
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_memory_observations_embedding ON mcp_memory_observations 
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_memory_observations_entity ON mcp_memory_observations(entity_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_from ON mcp_memory_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_to ON mcp_memory_relations(to_entity_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON mcp_memory_relations(relation_type);

-- Trigger for entity updated_at
DROP TRIGGER IF EXISTS update_memory_entity_timestamp ON mcp_memory_entities;
CREATE TRIGGER update_memory_entity_timestamp
    BEFORE UPDATE ON mcp_memory_entities
    FOR EACH ROW
    EXECUTE FUNCTION update_mcp_timestamp();

-- View for entity statistics
CREATE OR REPLACE VIEW mcp_memory_stats AS
SELECT 
    COUNT(DISTINCT e.id) as total_entities,
    COUNT(DISTINCT e.entity_type) as unique_types,
    COUNT(o.id) as total_observations,
    COUNT(r.id) as total_relations,
    MAX(e.updated_at) as last_updated
FROM mcp_memory_entities e
LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id
LEFT JOIN mcp_memory_relations r ON e.id = r.from_entity_id OR e.id = r.to_entity_id;

-- Function to search entities by text query (keyword search)
CREATE OR REPLACE FUNCTION search_memory_entities_text(
    query_text text,
    max_results int DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    name VARCHAR,
    entity_type VARCHAR,
    rank real,
    observation_count bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.name,
        e.entity_type,
        ts_rank(e.search_vector, plainto_tsquery('english', query_text)) as rank,
        COUNT(o.id) as observation_count
    FROM mcp_memory_entities e
    LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id
    WHERE e.search_vector @@ plainto_tsquery('english', query_text)
    GROUP BY e.id, e.name, e.entity_type, e.search_vector
    ORDER BY rank DESC
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Function to search entities by semantic similarity (vector search)
CREATE OR REPLACE FUNCTION search_memory_entities_semantic(
    query_embedding vector(1536),
    similarity_threshold float DEFAULT 0.7,
    max_results int DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    name VARCHAR,
    entity_type VARCHAR,
    similarity float,
    observation_count bigint
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.name,
        e.entity_type,
        1 - (e.embedding <=> query_embedding) as similarity,
        COUNT(o.id) as observation_count
    FROM mcp_memory_entities e
    LEFT JOIN mcp_memory_observations o ON e.id = o.entity_id
    WHERE e.embedding IS NOT NULL
      AND 1 - (e.embedding <=> query_embedding) >= similarity_threshold
    GROUP BY e.id, e.name, e.entity_type, e.embedding
    ORDER BY e.embedding <=> query_embedding
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE mcp_memory_entities IS 'Knowledge graph entities with semantic embeddings and full-text search';
COMMENT ON TABLE mcp_memory_observations IS 'Facts and observations about entities';
COMMENT ON TABLE mcp_memory_relations IS 'Relationships between entities in knowledge graph';
COMMENT ON VIEW mcp_memory_stats IS 'Statistics about the knowledge graph';
COMMENT ON FUNCTION search_memory_entities_text IS 'Full-text keyword search across entity names and types';
COMMENT ON FUNCTION search_memory_entities_semantic IS 'Semantic similarity search using pgvector embeddings';

