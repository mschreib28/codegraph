#!/usr/bin/env node
/**
 * Spikes G and H: embedding storage layout + in-memory cache.
 *
 * G. Storage split: keep embeddings INLINE on `symbol_summaries`
 *    vs SPLIT into a dedicated `symbol_embeddings` table. Measure
 *    summary-only scan latency (the common path) and summary +
 *    embedding scan latency (the rare path).
 *
 * H. In-memory similarity cache: cold-from-SQLite per query vs
 *    pre-decoded Float32Array matrix. Measure top-K cosine search
 *    latency.
 *
 * Synthesises 50K symbol_summaries + 768-dim embeddings to mirror
 * a realistic mid-size codebase. Codegraph's own DB at ~2K nodes
 * is too small to surface differences.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODES = 50_000;
const EMBED_DIM = 768;
const EMBED_COUNT = NODES;

function ms(start) { return Number(process.hrtime.bigint() - start) / 1_000_000; }
function fmt(n) { return n < 10 ? n.toFixed(2) : n.toFixed(0); }

console.log('\n=== Spike: embedding storage + in-memory cache ===\n');
console.log(`Synthesizing ${EMBED_COUNT.toLocaleString()} summaries + ${EMBED_DIM}d embeddings...`);

// ============================================================================
// Spike G: inline vs split
// ============================================================================
console.log('\n--- Spike G: storage layout (inline vs split) ---\n');

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

function timeQuery(db, label, sql, params = []) {
  const N = 50;
  const stmt = db.prepare(sql);
  const t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) stmt.all(...params);
  const avg = ms(t) / N;
  console.log(`  ${label}: ${fmt(avg)}ms avg over ${N} queries`);
  return avg;
}
console.log('\n  Test: scan summaries by role (common path — embedding bytes are dead weight in inline)');
const inlineNoEmb = timeQuery(
  inline.db,
  'inline',
  `SELECT node_id, summary FROM summaries WHERE role = ?`,
  ['business_logic']
);
const splitNoEmb = timeQuery(
  splitT.db,
  'split ',
  `SELECT node_id, summary FROM summaries WHERE role = ?`,
  ['business_logic']
);
console.log(`  Δ summary-only: split is ${(inlineNoEmb / splitNoEmb).toFixed(2)}× faster`);

console.log('\n  Test: scan summaries WITH embedding (rare path — split pays a JOIN)');
const inlineWithEmb = timeQuery(
  inline.db,
  'inline (single table)   ',
  `SELECT node_id, summary, embedding FROM summaries`
);
const splitWithEmb = timeQuery(
  splitT.db,
  'split  (join required)  ',
  `SELECT s.node_id, s.summary, e.embedding FROM summaries s JOIN embeddings e ON e.node_id = s.node_id`
);
console.log(`  Δ summary+embedding: ${(splitWithEmb / inlineWithEmb).toFixed(2)}× cost penalty for split (>1 = split slower)`);

// ============================================================================
// Spike H: in-memory cache
// ============================================================================
console.log('\n--- Spike H: in-memory embedding cache ---\n');

const QUERIES = 20;
const TOP_K = 10;

const queryVec = new Float32Array(EMBED_DIM);
for (let i = 0; i < EMBED_DIM; i++) queryVec[i] = Math.random();

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function bytesToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const coldStmt = inline.db.prepare('SELECT node_id, embedding FROM summaries');
let t0 = process.hrtime.bigint();
for (let q = 0; q < QUERIES; q++) {
  const rows = coldStmt.all();
  const scores = [];
  for (const r of rows) {
    const v = bytesToVec(r.embedding);
    scores.push({ id: r.node_id, score: cosine(queryVec, v) });
  }
  scores.sort((a, b) => b.score - a.score);
  scores.slice(0, TOP_K);
}
const coldMs = ms(t0) / QUERIES;
console.log(`  cold (per-query SQLite fetch + decode): ${fmt(coldMs)}ms avg over ${QUERIES} queries`);

const ids = [];
const matrix = new Float32Array(EMBED_COUNT * EMBED_DIM);
let row = 0;
for (const r of coldStmt.all()) {
  ids.push(r.node_id);
  matrix.set(bytesToVec(r.embedding), row * EMBED_DIM);
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
console.log(`  warm (in-memory Float32Array matrix)  : ${fmt(warmMs)}ms avg over ${QUERIES} queries`);
console.log(`  Δ similarity search: ${(coldMs / warmMs).toFixed(1)}× speedup with in-memory cache`);

inline.db.close(); splitT.db.close();
fs.unlinkSync(inline.dbPath); fs.unlinkSync(splitT.dbPath);

console.log('\n=== Done ===\n');
