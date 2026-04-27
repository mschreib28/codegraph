-- CodeGraph SQLite Schema
-- Version 1

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- Insert initial version
INSERT INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial schema');

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
    decorators TEXT, -- JSON array
    type_parameters TEXT, -- JSON array
    updated_at INTEGER NOT NULL,
    centrality REAL DEFAULT NULL -- PageRank over calls+references; NULL until first compute
);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT, -- JSON object
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
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT, -- JSON array
    -- Churn signals (mined from git log)
    commit_count INTEGER NOT NULL DEFAULT 0,
    loc INTEGER NOT NULL DEFAULT 0,
    first_seen_ts INTEGER DEFAULT NULL, -- unix seconds
    last_touched_ts INTEGER DEFAULT NULL -- unix seconds
);

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT, -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

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
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_centrality ON nodes(centrality DESC);

-- Full-text search index on node names, docstrings, and signatures
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

-- Edge indexes
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

-- Uniqueness for (source, target, kind, line, col). The id column is an
-- AUTOINCREMENT primary key, so without this index `INSERT OR IGNORE`
-- would never see a conflict — duplicate edges would silently accumulate
-- on every re-resolution / re-emission. COALESCE keeps two NULL line/col
-- values comparable as equal (SQLite treats raw NULLs in a UNIQUE index
-- as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
CREATE INDEX IF NOT EXISTS idx_files_commit_count ON files(commit_count DESC);
CREATE INDEX IF NOT EXISTS idx_files_last_touched ON files(last_touched_ts DESC);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

-- Project metadata for version/provenance tracking
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Issue → symbol attribution mined from git history.
-- One row per (node, issue, commit, kind) tuple; kind is 'modified'
-- (enclosing function changed by hunk), 'added' (declaration on a +
-- line), or 'removed' (declaration on a - line, dropped at lookup
-- time when no current node matches).
CREATE TABLE IF NOT EXISTS symbol_issues (
    node_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('modified','added','removed')),
    PRIMARY KEY (node_id, issue_number, commit_sha, kind),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbol_issues_node ON symbol_issues(node_id);
CREATE INDEX IF NOT EXISTS idx_symbol_issues_issue ON symbol_issues(issue_number);

-- Config references: read sites for env vars / feature flags / etc.
-- One row per syntactic occurrence in source. config_kind narrows to
-- 'env' (process.env, os.getenv, ...) for v1; future kinds add YAML
-- keys, LaunchDarkly flags, etc. source_node_id may be NULL for
-- top-level reads that aren't inside a function/method.
CREATE TABLE IF NOT EXISTS config_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_kind TEXT NOT NULL,
    config_key TEXT NOT NULL,
    source_node_id TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_config_refs_key
    ON config_refs(config_kind, config_key);
CREATE INDEX IF NOT EXISTS idx_config_refs_node
    ON config_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_config_refs_file
    ON config_refs(file_path);

-- SQL references: per-call-site links from app code to a table name.
-- One row per syntactic occurrence in source. op is 'read' (SELECT,
-- FROM in non-DDL), 'write' (INSERT/UPDATE/DELETE), or 'ddl'
-- (CREATE TABLE / ALTER TABLE / DROP TABLE -- rare in app code but
-- catches migration scripts).
CREATE TABLE IF NOT EXISTS sql_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('read','write','ddl')),
    source_node_id TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sql_refs_table
    ON sql_refs(lower(table_name));
CREATE INDEX IF NOT EXISTS idx_sql_refs_node
    ON sql_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_sql_refs_file
    ON sql_refs(file_path);
