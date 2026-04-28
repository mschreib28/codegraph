#!/usr/bin/env node
/**
 * Spike: redundant edge indexes
 *
 * Drops `idx_edges_source` and `idx_edges_target` and measures
 * the impact on:
 *   - DB size
 *   - Bulk-insert throughput
 *   - Latency for `WHERE source = ?` and `WHERE target = ?`
 *     (the two queries that previously hit the dropped indexes)
 *
 * The hypothesis: SQLite covers source-only / target-only lookups
 * via the wider `(source, kind)` and `(target, kind)` composite
 * indexes through left-prefix scan, so dropping the narrow ones
 * costs nothing on the read side but saves space and write time.
 *
 * Synthesises 50K nodes / 250K edges so the measurement scales to
 * what real users will hit; codegraph's own DB at ~2K nodes is too
 * small for index choices to surface.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODES = 50_000;
const EDGES_PER_NODE = 5;

function ms(start) { return Number(process.hrtime.bigint() - start) / 1_000_000; }
function fmt(n) { return n < 10 ? n.toFixed(2) : n.toFixed(0); }

console.log('\n=== Spike: redundant edge indexes ===\n');
console.log(`Synthesizing ${NODES.toLocaleString()} nodes, ${(NODES*EDGES_PER_NODE).toLocaleString()} edges...`);

function buildEdgesDb({ withRedundant }) {
  const dbPath = path.join(os.tmpdir(), `spike-edges-${Date.now()}-${Math.random()}.db`);
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
  `);
  if (withRedundant) {
    db.exec(`
      CREATE INDEX idx_edges_source ON edges(source);
      CREATE INDEX idx_edges_target ON edges(target);
    `);
  }

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

  return { db, dbPath, size: fs.statSync(dbPath).size, insertMs };
}

const baseline = buildEdgesDb({ withRedundant: true });
const stripped = buildEdgesDb({ withRedundant: false });

console.log('');
console.log(`  baseline (with redundant): size=${(baseline.size / 1024 / 1024).toFixed(1)} MB · bulk insert=${fmt(baseline.insertMs)}ms`);
console.log(`  stripped               : size=${(stripped.size / 1024 / 1024).toFixed(1)} MB · bulk insert=${fmt(stripped.insertMs)}ms`);
const sizeDelta = ((baseline.size - stripped.size) / baseline.size * 100).toFixed(1);
const insertSpeedup = (baseline.insertMs / stripped.insertMs).toFixed(2);
console.log(`  Δ size: -${sizeDelta}% · Δ bulk insert: ${insertSpeedup}× faster without redundant indexes`);

function timeQueries(db, label) {
  const N = 500;
  const sourceOnly = db.prepare('SELECT COUNT(*) FROM edges WHERE source = ?');
  const targetOnly = db.prepare('SELECT COUNT(*) FROM edges WHERE target = ?');
  let t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) sourceOnly.get(`n${i % NODES}`);
  const sourceMs = ms(t) / N;
  t = process.hrtime.bigint();
  for (let i = 0; i < N; i++) targetOnly.get(`n${i % NODES}`);
  const targetMs = ms(t) / N;
  console.log(`  ${label}: WHERE source=? avg ${fmt(sourceMs)}ms · WHERE target=? avg ${fmt(targetMs)}ms`);
  return { sourceMs, targetMs };
}
console.log('');
const baseQ = timeQueries(baseline.db, 'baseline');
const strQ = timeQueries(stripped.db, 'stripped');
console.log(`  query speed delta: source ${(strQ.sourceMs / baseQ.sourceMs).toFixed(2)}× · target ${(strQ.targetMs / baseQ.targetMs).toFixed(2)}× (>1 = stripped slower)`);

// EXPLAIN-confirm that the stripped DB still uses an index for these
// queries — we want to know it's a covering scan, not a table scan.
const plan = stripped.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM edges WHERE source = ?').all('n0');
console.log('');
console.log('  EXPLAIN (stripped, source=?):');
for (const row of plan) console.log(`    ${row.detail}`);

baseline.db.close(); stripped.db.close();
fs.unlinkSync(baseline.dbPath); fs.unlinkSync(stripped.dbPath);

console.log('\n=== Done ===\n');
