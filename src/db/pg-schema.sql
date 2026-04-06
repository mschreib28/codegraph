-- CodeGraph PostgreSQL Schema
-- Version 1
--
-- PostgreSQL equivalent of schema.sql (SQLite).
-- Key differences:
--   - SERIAL instead of AUTOINCREMENT
--   - tsvector + GIN instead of FTS5
--   - Trigger function instead of FTS5 sync triggers
--   - No COLLATE NOCASE (handled in queries via LOWER())

-- =============================================================================
-- Schema Version Tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at BIGINT NOT NULL,
    description TEXT
);

INSERT INTO schema_versions (version, applied_at, description)
VALUES (1, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT, 'Initial PostgreSQL schema')
ON CONFLICT (version) DO NOTHING;

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Nodes: Code symbols (functions, classes, variables, etc.)
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT,          -- JSON array
    type_parameters TEXT,     -- JSON array
    updated_at BIGINT NOT NULL,
    -- Full-text search vector (populated by trigger)
    search_vector tsvector
);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id SERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT,            -- JSON object
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Files: Tracked source files
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at BIGINT NOT NULL,
    indexed_at BIGINT NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT               -- JSON array
);

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id SERIAL PRIMARY KEY,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT,          -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- Full-Text Search (tsvector + GIN)
-- =============================================================================

-- Trigger function to maintain the search_vector column
CREATE OR REPLACE FUNCTION update_nodes_search_vector()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('simple', COALESCE(NEW.name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.qualified_name, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.docstring, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.signature, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: update search_vector on INSERT or UPDATE
CREATE OR REPLACE TRIGGER trg_nodes_search_vector
    BEFORE INSERT OR UPDATE ON nodes
    FOR EACH ROW EXECUTE FUNCTION update_nodes_search_vector();

-- GIN index for fast tsvector searches
CREATE INDEX IF NOT EXISTS idx_nodes_search_vector ON nodes USING gin(search_vector);

-- =============================================================================
-- Indexes for Query Performance
-- =============================================================================

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(LOWER(name));

-- Edge indexes
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);

-- =============================================================================
-- Vector Storage
-- =============================================================================

-- Vector embeddings for semantic search
-- Uses pgvector extension for native vector type and ANN indexes
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vectors (
    node_id TEXT PRIMARY KEY,
    embedding vector(768) NOT NULL,
    model TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX IF NOT EXISTS idx_vectors_embedding
    ON vectors USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- Project Metadata
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at BIGINT NOT NULL
);
