#!/usr/bin/env node
/**
 * Spikes F, G, H: DB-layer optimization measurements.
 *
 * F. Redundant indexes: drop idx_edges_source, idx_edges_target,
 *    idx_co_changes_a — measure size delta, bulk-insert speed, and
 *    query latency for the queries that previously used them.
 * G. Embedding split: vs inline. Measure summary-only-scan latency,
 *    summary+embedding latency.
 * H. In-memory embedding cache: cold-from-sqlite vs cached
 *    Float32Array. Measure top-K cosine search latency.
 *
 * Generates synthetic real-shape data so measurements scale to what
 * users will hit. Codegraph's own DB at 2K nodes is too small to
 * surface meaningful differences.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODES = 50_000;     // Realistic mid-size codebase
const EDGES_PER_NODE = 5;
const EMBED_DIM = 768;
const EMBED_COUNT = NODES;

function ms(start) { return Number(process.hrtime.bigint() - start) / 1_000_000; }
function fmt(n) { return n < 10 ? n.toFixed(2) : n.toFixed(0); }

console.log('\n=== DB-layer optimization spikes ===\n');
console.log(`Synthesizing ${NODES.toLocaleString()} nodes, ${(NODES*EDGES_PER_NODE).toLocaleString()} edges, ${EMBED_COUNT.toLocaleString()} ${EMBED_DIM}d embeddings...`);

// ============================================================================
// Spike F: Redundant indexes
// ============================================================================
console.log('\n--- Spike F: Redundant indexes (idx_edges_source, idx_edges_target, idx_co_changes_a) ---\n');

function buildEdgesDb({ withRedundant }) {
  const dbPath = path.join(os.tmpdir(), `spike-edges-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
      line INTEGER, col INTEGER
    );
    CREATE INDEX idx_edges_kind ON edges(kind);
    CREATE INDEX idx_edges_source_kind ON edges(source, kind);
    CREATE INDEX idx_edges_target_kind ON edges(target, kind);
    CREATE UNIQUE INDEX idx_edges_unique
      ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));
  `);
  if (withRedundant) {
    db.exec(`
      CREATE INDEX idx_edges_source ON edges(source);
      CREATE INDEX idx_edges_target ON edges(target);
    `);
  }

  // Insert nodes + edges in bulk
  const insNode = db.prepare('INSERT INTO nodes (id, kind, name) VALUES (?, ?, ?)');
  const insEdge = db.prepare('INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)');
  const KINDS = ['calls', 'imports', 'references', 'type_of', 'extends', 'instantiates'];
  const tStart = process.hrtime.bigint();
  db.transaction(() => {
    for (let i = 0; i < NODES; i++) {
      insNode.run(`n${i}`, 'function', `name${i}`);
    }
    for (let i = 0; i < NODES; i++) {
      for (let j = 0; j < EDGES_PER_NODE; j++) {
        const tgt = `n${(i + j + 1) % NODES}`;
        const kind = KINDS[j % KINDS.length];
        insEdge.run(`n${i}`, tgt, kind, i, j);
      }
    }
  })();
  const insertMs = ms(tStart);
  db.exec('PRAGMA optimize');

  const size = fs.statSync(dbPath).size;
  return { db, dbPath, size, insertMs };
}

const baseline = buildEdgesDb({ withRedundant: true });
const stripped = buildEdgesDb({ withRedundant: false });

console.log(`  baseline  (with redundant): size=${(baseline.size / 1024 / 1024).toFixed(1)} MB · bulk insert=${fmt(baseline.insertMs)}ms`);
console.log(`  stripped (without redundant): size=${(stripped.size / 1024 / 1024).toFixed(1)} MB · bulk insert=${fmt(stripped.insertMs)}ms`);
const sizeDelta = ((baseline.size - stripped.size) / baseline.size * 100).toFixed(1);
const insertSpeedup = (baseline.insertMs / stripped.insertMs).toFixed(2);
console.log(`  Δ size: -${sizeDelta}% · Δ bulk insert: ${insertSpeedup}× faster without redundant indexes`);

// Query speed: queries that USED to hit dropped indexes
function timeQueries(db, label) {
  const N = 500;
  const sourceOnly = db.prepare('SELECT COUNT(*) FROM edges WHERE source = ?');
  const targetOnly = db.prepare('SELECT COUNT(*) FROM edges WHERE target = ?');
  let t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) sourceOnly.get(`n${i % NODES}`);
  const sourceMs = ms(t1) / N;
  t1 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) targetOnly.get(`n${i % NODES}`);
  const targetMs = ms(t1) / N;
  console.log(`  ${label}: WHERE source=? avg ${fmt(sourceMs)}ms · WHERE target=? avg ${fmt(targetMs)}ms`);
  return { sourceMs, targetMs };
}
const baseQ = timeQueries(baseline.db, 'baseline ');
const strQ = timeQueries(stripped.db, 'stripped ');
console.log(`  query speed delta: source ${(strQ.sourceMs / baseQ.sourceMs).toFixed(2)}× · target ${(strQ.targetMs / baseQ.targetMs).toFixed(2)}× (>1 = stripped slower)`);

baseline.db.close(); stripped.db.close();
fs.unlinkSync(baseline.dbPath); fs.unlinkSync(stripped.dbPath);

// ============================================================================
// Spike G: Embedding storage split
// ============================================================================
console.log('\n--- Spike G: Embedding storage split (inline vs separate table) ---\n');

function buildEmbedDb({ split }) {
  const dbPath = path.join(os.tmpdir(), `spike-embed-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  if (split) {
    db.exec(`
      CREATE TABLE summaries (
        node_id TEXT PRIMARY KEY, summary TEXT NOT NULL,
        model TEXT NOT NULL, generated_at INTEGER NOT NULL,
        role TEXT, role_model TEXT
      );
      CREATE TABLE embeddings (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        embedding_model TEXT NOT NULL
      );
    `);
  } else {
    db.exec(`
      CREATE TABLE summaries (
        node_id TEXT PRIMARY KEY, summary TEXT NOT NULL,
        model TEXT NOT NULL, generated_at INTEGER NOT NULL,
        embedding BLOB, embedding_model TEXT,
        role TEXT, role_model TEXT
      );
    `);
  }
  // Synthetic populate
  const sample = 'A typical one-line summary describing what this function does, with reasonable length.';
  const buf = Buffer.alloc(EMBED_DIM * 4);
  for (let i = 0; i < EMBED_DIM; i++) buf.writeFloatLE(Math.random() * 0.1, i * 4);

  if (split) {
    const insS = db.prepare('INSERT INTO summaries (node_id, summary, model, generated_at, role) VALUES (?, ?, ?, ?, ?)');
    const insE = db.prepare('INSERT INTO embeddings (node_id, embedding, embedding_model) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < EMBED_COUNT; i++) {
        insS.run(`n${i}`, sample, 'qwen2.5-coder', Date.now(), 'business_logic');
        insE.run(`n${i}`, buf, 'nomic-embed-text');
      }
    })();
  } else {
    const ins = db.prepare(`
      INSERT INTO summaries (node_id, summary, model, generated_at, embedding, embedding_model, role)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let i = 0; i < EMBED_COUNT; i++) {
        ins.run(`n${i}`, sample, 'qwen2.5-coder', Date.now(), buf, 'nomic-embed-text', 'business_logic');
      }
    })();
  }

  return { db, dbPath, size: fs.statSync(dbPath).size };
}

const inline = buildEmbedDb({ split: false });
const splitT = buildEmbedDb({ split: true });

console.log(`  inline DB: ${(inline.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  split  DB: ${(splitT.size / 1024 / 1024).toFixed(1)} MB`);

// Summary-only scan: get summaries by role (no embedding needed)
function timeQuery(db, label, sql, params = []) {
  const N = 50;
  const stmt = db.prepare(sql);
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) stmt.all(...params);
  const avg = ms(t) / N;
  console.log(`  ${label}: ${fmt(avg)}ms avg over ${N} queries`);
  return avg;
}
console.log('\n  Test: scan all rows by role (typical query, no embedding needed)');
const inlineNoEmb = timeQuery(
  inline.db,
  'inline (reads embeddings even if unused)',
  `SELECT node_id, summary FROM summaries WHERE role = ?`,
  ['business_logic']
);
const splitNoEmb = timeQuery(
  splitT.db,
  'split  (separate page chain)            ',
  `SELECT node_id, summary FROM summaries WHERE role = ?`,
  ['business_logic']
);
console.log(`  Δ summary-only: split is ${(inlineNoEmb / splitNoEmb).toFixed(2)}× faster`);

// Test 2: scan WITH embeddings (rare, but the cost case)
console.log('\n  Test: scan all rows including embedding (similarity search prep)');
const inlineWithEmb = timeQuery(
  inline.db,
  'inline (single table)                    ',
  `SELECT node_id, summary, embedding FROM summaries`
);
const splitWithEmb = timeQuery(
  splitT.db,
  'split  (join required)                   ',
  `SELECT s.node_id, s.summary, e.embedding FROM summaries s JOIN embeddings e ON e.node_id = s.node_id`
);
console.log(`  Δ summary+embedding: ${(splitWithEmb / inlineWithEmb).toFixed(2)}× cost penalty for split (>1 = split slower)`);

// ============================================================================
// Spike H: In-memory embedding cache for similarity search
// ============================================================================
console.log('\n--- Spike H: In-memory embedding cache for similarity search ---\n');

const QUERIES = 20;
const TOP_K = 10;

// Cold path: load all embeddings from SQLite per query
const queryVec = new Float32Array(EMBED_DIM);
for (let i = 0; i < EMBED_DIM; i++) queryVec[i] = Math.random();

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bytesToVec(buf) {
  // Zero-copy if aligned
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const coldStmt = inline.db.prepare('SELECT node_id, embedding FROM summaries');
let t0 = process.hrtime.bigint();
for (let q = 0; q < QUERIES; q++) {
  const rows = coldStmt.all();
  // Top-K via min-heap simulated with sort
  const scores = [];
  for (const r of rows) {
    const v = bytesToVec(r.embedding);
    scores.push({ id: r.node_id, score: cosine(queryVec, v) });
  }
  scores.sort((a, b) => b.score - a.score);
  scores.slice(0, TOP_K);
}
const coldMs = ms(t0) / QUERIES;
console.log(`  cold (per-query SQLite fetch): ${fmt(coldMs)}ms avg over ${QUERIES} queries`);

// Warm path: load once into Float32Array matrix, then dot products in-memory
const ids = [];
const matrix = new Float32Array(EMBED_COUNT * EMBED_DIM);
let row = 0;
for (const r of coldStmt.all()) {
  ids.push(r.node_id);
  const v = bytesToVec(r.embedding);
  matrix.set(v, row * EMBED_DIM);
  row++;
}
let t1 = process.hrtime.bigint();
for (let q = 0; q < QUERIES; q++) {
  const scores = [];
  for (let i = 0; i < EMBED_COUNT; i++) {
    let s = 0;
    const off = i * EMBED_DIM;
    for (let d = 0; d < EMBED_DIM; d++) s += matrix[off + d] * queryVec[d];
    scores.push({ id: ids[i], score: s });
  }
  scores.sort((a, b) => b.score - a.score);
  scores.slice(0, TOP_K);
}
const warmMs = ms(t1) / QUERIES;
console.log(`  warm (in-memory Float32Array): ${fmt(warmMs)}ms avg over ${QUERIES} queries`);
console.log(`  Δ similarity search: ${(coldMs / warmMs).toFixed(1)}× speedup with in-memory cache`);

inline.db.close(); splitT.db.close();
fs.unlinkSync(inline.dbPath); fs.unlinkSync(splitT.dbPath);

console.log('\n=== Spikes complete ===\n');
