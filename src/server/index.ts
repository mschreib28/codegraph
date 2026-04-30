/**
 * CodeGraph web UI server.
 *
 * Boots a tiny HTTP server (Node built-in `http`) that serves a single-page
 * D3 force-directed graph plus a small REST API backed by the existing
 * `CodeGraph` instance. Designed to run alongside (or independent of) the
 * MCP stdio server.
 *
 * Endpoints:
 *   GET /                       → public/index.html
 *   GET /static/*               → public/static/*
 *   GET /api/graph              → file-level UiGraph
 *   GET /api/file/:id/expand    → symbols + internal edges for one file
 *   GET /api/search?q=...       → matched files weighted by FTS5 score
 *   GET /api/node/:id           → full node details
 *   GET /api/stats              → index stats (used in header)
 *   GET /api/complexity         → ComplexityReport (per-file + treemap)
 *   GET /api/complexity/file/:path → per-symbol metrics for one file
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import type { CodeGraph } from '../index';
import {
  buildFileGraph,
  buildComplexityReport,
  expandFile,
  searchAndProject,
  UiGraph,
} from './graph-projection';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

export interface UiServerOptions {
  port: number;
  host?: string;
}

export interface UiServerHandle {
  server: http.Server;
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

/**
 * Start the UI HTTP server. Caches the built file graph in memory and
 * serves it on every /api/graph hit. Cache invalidates when /api/refresh
 * is called (e.g. after a sync).
 */
export async function startUiServer(
  cg: CodeGraph,
  options: UiServerOptions
): Promise<UiServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port;
  const publicDir = resolvePublicDir();

  let graphCache: UiGraph | null = null;
  const getGraph = (): UiGraph => {
    if (!graphCache) graphCache = buildFileGraph(cg);
    return graphCache;
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, cg, publicDir, getGraph, () => {
      graphCache = null;
    }).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const url = `http://${host}:${port}`;

  return {
    server,
    port,
    host,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cg: CodeGraph,
  publicDir: string,
  getGraph: () => UiGraph,
  invalidate: () => void
): Promise<void> {
  if (!req.url) {
    sendJson(res, 400, { error: 'Missing URL' });
    return;
  }
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  // Only allow GET (the API is read-only).
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return;
  }

  // ---- API routes ---------------------------------------------------------
  if (pathname === '/api/graph') {
    sendJson(res, 200, getGraph());
    return;
  }

  if (pathname === '/api/refresh') {
    invalidate();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/stats') {
    sendJson(res, 200, cg.getStats());
    return;
  }

  if (pathname === '/api/complexity') {
    sendJson(res, 200, buildComplexityReport(cg));
    return;
  }

  // /api/complexity/file/<urlencoded path>
  const complexityFileMatch = pathname.match(/^\/api\/complexity\/file\/(.+)$/);
  if (complexityFileMatch && complexityFileMatch[1]) {
    const filePath = decodeURIComponent(complexityFileMatch[1]);
    sendJson(res, 200, { filePath, metrics: cg.getComplexityForFile(filePath) });
    return;
  }

  if (pathname === '/api/search') {
    const q = parsed.searchParams.get('q')?.trim();
    if (!q) {
      sendJson(res, 400, { error: 'Missing query parameter `q`' });
      return;
    }
    const limit = clampInt(parsed.searchParams.get('limit'), 1, 1000, 200);
    sendJson(res, 200, searchAndProject(cg, getGraph(), q, limit));
    return;
  }

  // /api/file/<urlencoded fileId>/expand
  const expandMatch = pathname.match(/^\/api\/file\/(.+)\/expand$/);
  if (expandMatch && expandMatch[1]) {
    const fileId = decodeURIComponent(expandMatch[1]);
    sendJson(res, 200, expandFile(cg, fileId));
    return;
  }

  // /api/node/<urlencoded id>
  const nodeMatch = pathname.match(/^\/api\/node\/(.+)$/);
  if (nodeMatch && nodeMatch[1]) {
    const nodeId = decodeURIComponent(nodeMatch[1]);
    const node = cg.getNode(nodeId);
    if (!node) {
      sendJson(res, 404, { error: `Node ${nodeId} not found` });
      return;
    }
    const incoming = cg.getIncomingEdges(nodeId);
    const outgoing = cg.getOutgoingEdges(nodeId);
    sendJson(res, 200, { node, incoming, outgoing });
    return;
  }

  // ---- Static assets ------------------------------------------------------
  if (pathname === '/' || pathname === '/index.html') {
    serveFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  if (pathname.startsWith('/static/')) {
    const safe = sanitizeStaticPath(pathname.slice('/static/'.length));
    if (!safe) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    serveFile(res, path.join(publicDir, 'static', safe));
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = err.code === 'ENOENT' ? 404 : 500;
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Internal Server Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    res.statusCode = 200;
    res.end(data);
  });
}

function sanitizeStaticPath(relative: string): string | null {
  // Reject path traversal — only allow plain forward-slash relative paths
  // with no `..` segments.
  if (relative.includes('\0')) return null;
  const normalized = path.posix.normalize(relative);
  if (normalized.startsWith('..') || normalized.startsWith('/') || normalized.includes('\\')) {
    return null;
  }
  return normalized;
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Locate the bundled `public/` directory. Works both when running from
 * `dist/server/index.js` (npm-installed) and when running from `src/`
 * during development.
 */
function resolvePublicDir(): string {
  const candidates = [
    path.join(__dirname, '..', 'public'),         // dist/server → dist/public
    path.join(__dirname, '..', '..', 'public'),   // src/server  → ./public
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  // Fall back to the first candidate so the error message is informative.
  return candidates[0]!;
}
