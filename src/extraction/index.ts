/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
  CodeGraphConfig,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './extract-dispatcher';
import { detectLanguage, isLanguageSupported, initGrammars, loadGrammarsForLanguages } from './grammars';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath } from '../utils';
import picomatch from 'picomatch';

/**
 * Number of files to read in parallel during indexing.
 * File reads are I/O-bound; batching overlaps I/O wait with CPU parse work.
 */
const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL moved to parse-worker.ts (runs in worker thread)

/**
 * Maximum time (ms) to wait for a single file to parse in the worker thread.
 * If tree-sitter hangs or WASM runs out of memory, this prevents the entire
 * indexing run from freezing. The worker is restarted after a timeout.
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * Number of files to parse before recycling the worker thread.
 * WASM linear memory can grow but NEVER shrink (WebAssembly spec limitation).
 * The only way to reclaim tree-sitter's WASM heap is to destroy the entire
 * V8 isolate by terminating the worker thread and spawning a fresh one.
 * This interval balances memory usage against the cost of reloading grammars.
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a path matches any glob pattern (simplified)
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  filePath = normalizePath(filePath);
  return picomatch.isMatch(filePath, pattern, { dot: true });
}

/**
 * Check if a file should be included based on config
 */
export function shouldIncludeFile(
  filePath: string,
  config: CodeGraphConfig
): boolean {
  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesGlob(filePath, pattern)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesGlob(filePath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Enumerate all initialized submodule paths (recursively), relative to `rootDir`.
 *
 * Uses `git submodule foreach` so we get exactly the submodules git considers
 * active — uninitialized / deinitialized submodules are skipped automatically,
 * which is what we want (we can't ls-files inside a directory with no .git).
 *
 * Returns [] when there are no submodules or when the command fails. Errors
 * here are non-fatal: submodule indexing is a best-effort enhancement on top
 * of the parent-repo file scan.
 */
function getGitSubmodules(rootDir: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['submodule', 'foreach', '--recursive', '--quiet', 'echo "$displaypath"'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const paths: string[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) paths.push(normalizePath(trimmed));
    }
    return paths;
  } catch {
    return [];
  }
}

/**
 * Run `git ls-files -co --exclude-standard` inside a submodule and return
 * paths prefixed back into the parent repo's relative-path namespace.
 * Errors are swallowed so one broken submodule doesn't fail the whole scan.
 */
function getSubmoduleFiles(rootDir: string, submodulePath: string): string[] {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '-co', '--exclude-standard'],
      {
        cwd: path.join(rootDir, submodulePath),
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const out: string[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) out.push(normalizePath(`${submodulePath}/${trimmed}`));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Get all files visible to git (tracked + untracked but not ignored).
 * Respects .gitignore at all levels (root, subdirectories) and recurses
 * into git submodules — `git ls-files` itself does not enter submodules,
 * so each one is enumerated separately and its paths are prefixed.
 * Pass `indexSubmodules: false` in config to skip the submodule walk.
 * Returns null on failure (non-git project) so callers can fall back.
 */
function getGitVisibleFiles(rootDir: string, config: CodeGraphConfig): Set<string> | null {
  try {
    // Check if the project directory is gitignored by a parent repo.
    // When rootDir lives inside a parent git repo that ignores it,
    // `git ls-files` returns nothing — fall back to filesystem walk.
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore exits 0 if the path IS ignored, 1 if not
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        // Directory is gitignored by parent repo — fall back to filesystem walk
        return null;
      } catch {
        // Not ignored — safe to use git ls-files
      }
    }

    // -c = cached (tracked), -o = others (untracked), --exclude-standard = respect .gitignore
    const output = execFileSync(
      'git',
      ['ls-files', '-co', '--exclude-standard'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const files = new Set<string>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        files.add(normalizePath(trimmed));
      }
    }

    // Recurse into submodules: each submodule has its own git index, and the
    // parent repo's ls-files only emits the submodule directory entry, not
    // the files inside.
    if (config.indexSubmodules !== false) {
      for (const submodulePath of getGitSubmodules(rootDir)) {
        for (const filePath of getSubmoduleFiles(rootDir, submodulePath)) {
          files.add(filePath);
        }
      }
    }

    return files;
  } catch {
    return null;
  }
}

/**
 * Result of git-based change detection.
 * Returns null when git is unavailable (non-git project or command failure),
 * signaling the caller to fall back to full filesystem scan.
 */
interface GitChanges {
  modified: string[];  // M, MM, AM — files to re-hash + re-index
  added: string[];     // ?? — new untracked files to index
  deleted: string[];   // D — files to remove from DB
}

/**
 * Decode the C-style-quoted path that `git status --porcelain` emits when
 * a path contains spaces, control chars, or non-ASCII bytes (the path is
 * wrapped in double quotes and individual bytes are escaped, e.g.
 *   "vendor/my\\040sub/file"
 * Returns the path unchanged if it isn't quoted.
 */
function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') {
    return raw;
  }
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      // Octal escape (up to 3 digits) representing a single byte
      let octal = next;
      let peek = body[i + 1];
      while (octal.length < 3 && peek !== undefined && peek >= '0' && peek <= '7') {
        octal += peek;
        i++;
        peek = body[i + 1];
      }
      bytes.push(parseInt(octal, 8));
    } else {
      const map: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
      bytes.push(map[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Run `git status --porcelain --no-renames` in `cwd` and bucket the entries.
 * `pathPrefix`, when non-empty, is prepended to every file path so submodule
 * status output can be reported relative to the parent repo's root.
 * `submoduleDirs` is the set of paths (relative to the parent root) that
 * are themselves submodule directories — the parent repo's status emits
 * a single entry per submodule (e.g. ` m sub`), and we ignore those because
 * the actual file-level changes are picked up by status runs inside each.
 *
 * Returns `true` if the command ran successfully (even if the working tree
 * was clean), `false` if it failed — callers use this to fall back to a
 * full filesystem scan when the parent-repo status is unreliable.
 */
function readGitStatus(
  cwd: string,
  pathPrefix: string,
  submoduleDirs: ReadonlySet<string>,
  config: CodeGraphConfig,
  buckets: GitChanges,
): boolean {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['status', '--porcelain', '--no-renames'],
      { cwd, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    return false;
  }

  for (const line of output.split('\n')) {
    if (line.length < 4) continue; // Minimum: "XY file"

    const statusCode = line.substring(0, 2);
    const rawPath = unquoteGitPath(line.substring(3));
    const filePath = pathPrefix
      ? normalizePath(`${pathPrefix}/${rawPath}`)
      : normalizePath(rawPath);

    // The submodule directory itself shows up as a status entry in the
    // parent repo (e.g. " m sub" when the submodule's HEAD has moved);
    // skip it — file-level changes are captured by recursing into the submodule.
    if (submoduleDirs.has(filePath)) continue;

    // Skip files that don't match include/exclude config
    if (!shouldIncludeFile(filePath, config)) continue;

    if (statusCode === '??') {
      buckets.added.push(filePath);
    } else if (statusCode.includes('D')) {
      buckets.deleted.push(filePath);
    } else {
      // M, MM, AM, A (staged), etc. — treat as modified
      buckets.modified.push(filePath);
    }
  }
  return true;
}

/**
 * Use `git status` to detect changed files instead of scanning every file.
 * Returns null on failure so callers fall back to full scan.
 *
 * Recurses into git submodules: status inside the parent repo only emits
 * a directory-level entry for a changed submodule, so we additionally run
 * status inside each active submodule to pick up file-level changes.
 * Submodule status failures are non-fatal — only a parent-repo failure
 * triggers the full-scan fallback.
 */
function getGitChangedFiles(rootDir: string, config: CodeGraphConfig): GitChanges | null {
  const submodules = config.indexSubmodules === false ? [] : getGitSubmodules(rootDir);
  const submoduleDirs = new Set(submodules);
  const buckets: GitChanges = { modified: [], added: [], deleted: [] };

  if (!readGitStatus(rootDir, '', submoduleDirs, config, buckets)) {
    return null;
  }
  for (const submodulePath of submodules) {
    readGitStatus(path.join(rootDir, submodulePath), submodulePath, submoduleDirs, config, buckets);
  }

  return buckets;
}

/**
 * Marker file name that indicates a directory (and all children) should be skipped
 */
const CODEGRAPH_IGNORE_MARKER = '.codegraphignore';

/**
 * Recursively scan directory for source files.
 *
 * In git repos, uses `git ls-files` to get the file list (inherently
 * respects .gitignore at all levels), then filters by config include patterns.
 * Falls back to filesystem walk for non-git projects.
 */
export function scanDirectory(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): string[] {
  // Fast path: use git to get all visible files (respects .gitignore everywhere)
  const gitFiles = getGitVisibleFiles(rootDir, config);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIncludeFile(filePath, config)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // Fallback: walk filesystem for non-git projects
  return scanDirectoryWalk(rootDir, config, onProgress);
}

/**
 * Async variant of scanDirectory that yields to the event loop periodically,
 * allowing worker threads to receive and render progress messages.
 */
export async function scanDirectoryAsync(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir, config);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (shouldIncludeFile(filePath, config)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // Yield every 100 files so worker threads can render progress
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, config, onProgress);
}

/**
 * Filesystem walk fallback for non-git projects.
 */
function scanDirectoryWalk(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();

  function walk(dir: string): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // Check for .codegraphignore marker file
    const ignoreMarker = path.join(dir, CODEGRAPH_IGNORE_MARKER);
    if (fs.existsSync(ignoreMarker)) {
      logDebug('Skipping directory due to .codegraphignore marker', { dir });
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            const dirPattern = relativePath + '/';
            let excluded = false;
            for (const pattern of config.exclude) {
              if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
                excluded = true;
                break;
              }
            }
            if (!excluded) {
              walk(fullPath);
            }
          } else if (stat.isFile()) {
            if (shouldIncludeFile(relativePath, config)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('Skipping broken symlink', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        const dirPattern = relativePath + '/';
        let excluded = false;
        for (const pattern of config.exclude) {
          if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (shouldIncludeFile(relativePath, config)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

class WorkerPool {
  private worker: import('worker_threads').Worker | null = null;
  private nextId = 0;
  private parseCount = 0;
  private readonly pending = new Map<number, {
    resolve: (result: ExtractionResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly WorkerClass: (typeof import('worker_threads').Worker) | null,
    private readonly workerPath: string,
    private readonly languages: string[],
    private readonly log: (msg: string) => void
  ) {}

  rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  private attachHandlers(w: import('worker_threads').Worker): void {
    w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult }) => {
      if (msg.type === 'parse-result' && msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          p.resolve(msg.result!);
        }
      }
    });
    w.on('error', (err) => {
      logWarn('Parse worker error', { error: err.message });
      this.rejectAllPending(`Worker error: ${err.message}`);
    });
    w.on('exit', (code) => {
      if (code !== 0 && this.pending.size > 0) {
        logWarn('Parse worker exited unexpectedly', { code });
        this.rejectAllPending(`Worker exited with code ${code}`);
      }
      if (this.worker === w) { this.worker = null; this.parseCount = 0; }
    });
  }

  async ensureWorker(): Promise<import('worker_threads').Worker> {
    if (this.worker) return this.worker;
    this.log('Spawning new parse worker...');
    this.worker = new this.WorkerClass!(this.workerPath);
    this.attachHandlers(this.worker);
    await new Promise<void>((resolve, reject) => {
      this.worker!.once('message', (msg: { type: string }) => {
        if (msg.type === 'grammars-loaded') resolve();
        else reject(new Error(`Unexpected message: ${msg.type}`));
      });
      this.worker!.postMessage({ type: 'load-grammars', languages: this.languages });
    });
    return this.worker;
  }

  recycle(): void {
    if (!this.worker) return;
    this.log(`Recycling worker after ${this.parseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
    const w = this.worker;
    this.worker = null;
    this.parseCount = 0;
    w.terminate().catch(() => {});
  }

  async requestParse(filePath: string, content: string): Promise<ExtractionResult> {
    if (!this.WorkerClass) {
      return extractFromSource(filePath, content, detectLanguage(filePath, content));
    }
    if (this.parseCount >= WORKER_RECYCLE_INTERVAL) await this.recycle();
    const worker = await this.ensureWorker();
    const id = this.nextId++;
    this.parseCount++;
    const timeoutMs = PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000;
    return new Promise<ExtractionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
        this.worker = null;
        this.parseCount = 0;
        reject(new Error(`Parse timed out after ${timeoutMs}ms`));
        worker.terminate().catch(() => {});
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ type: 'parse', id, filePath, content });
    });
  }

  shutdown(): void {
    this.rejectAllPending('Indexing complete');
    if (this.worker) this.worker.terminate().catch(() => {});
  }
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private config: CodeGraphConfig;
  private queries: QueryBuilder;

  constructor(rootDir: string, config: CodeGraphConfig, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.config = config;
    this.queries = queries;
  }

  /**
   * Index all files in the project
   */
  private makeAbortResult(
    startTime: number,
    counters: { filesIndexed: number; filesSkipped: number; filesErrored: number; totalNodes: number; totalEdges: number },
    errors: ExtractionError[]
  ): IndexResult {
    return {
      success: false,
      filesIndexed: counters.filesIndexed,
      filesSkipped: counters.filesSkipped,
      filesErrored: counters.filesErrored,
      nodesCreated: counters.totalNodes,
      edgesCreated: counters.totalEdges,
      errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
      durationMs: Date.now() - startTime,
    };
  }

  private async processFile(
    filePath: string,
    content: string,
    stats: fs.Stats,
    pool: WorkerPool,
    errors: ExtractionError[]
  ): Promise<{ status: 'indexed' | 'skipped' | 'errored'; nodes: number; edges: number }> {
    let result: ExtractionResult;
    try {
      result = await pool.requestParse(filePath, content);
    } catch (parseErr) {
      errors.push({
        message: parseErr instanceof Error ? parseErr.message : String(parseErr),
        filePath, severity: 'error', code: 'parse_error',
      });
      return { status: 'errored', nodes: 0, edges: 0 };
    }
    if (result.nodes.length > 0 || result.errors.length === 0) {
      const language = detectLanguage(filePath, content);
      this.storeExtractionResult(filePath, content, language, stats, result);
    }
    if (result.errors.length > 0) {
      for (const err of result.errors) { if (!err.filePath) err.filePath = filePath; }
      errors.push(...result.errors);
    }
    if (result.nodes.length > 0) {
      return { status: 'indexed', nodes: result.nodes.length, edges: result.edges.length };
    } else if (result.errors.some((e) => e.severity === 'error')) {
      return { status: 'errored', nodes: 0, edges: 0 };
    }
    return { status: 'skipped', nodes: 0, edges: 0 };
  }

  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const counters = { filesIndexed: 0, filesSkipped: 0, filesErrored: 0, totalNodes: 0, totalEdges: 0 };
    const log = verbose ? (msg: string) => { console.log(`[worker] ${msg}`); } : (_msg: string) => {};

    onProgress?.({ phase: 'scanning', current: 0, total: 0 });
    const files = await scanDirectoryAsync(this.rootDir, this.config, (current, file) => {
      onProgress?.({ phase: 'scanning', current, total: 0, currentFile: file });
    });
    if (signal?.aborted) return this.makeAbortResult(startTime, { filesIndexed: 0, filesSkipped: 0, filesErrored: 0, totalNodes: 0, totalEdges: 0 }, []);

    const total = files.length;
    let processed = 0;
    onProgress?.({ phase: 'parsing', current: 0, total });
    await new Promise(resolve => setImmediate(resolve));

    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) neededLanguages.push('cpp');

    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    let WorkerClass: typeof import('worker_threads').Worker | null = null;
    if (fs.existsSync(parseWorkerPath)) {
      const { Worker } = await import('worker_threads');
      WorkerClass = Worker;
    } else {
      await loadGrammarsForLanguages(neededLanguages);
    }

    const pool = new WorkerPool(WorkerClass, parseWorkerPath, neededLanguages, log);
    if (WorkerClass) await pool.ensureWorker();

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) { pool.shutdown(); return this.makeAbortResult(startTime, counters, errors); }
      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);
      const fileContents = await Promise.all(batch.map(async (fp) => {
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, fp);
          if (!fullPath) {
            logWarn('Path traversal blocked in batch reader', { filePath: fp });
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
          }
          const content = await fsp.readFile(fullPath, 'utf-8');
          const stats = await fsp.stat(fullPath);
          return { filePath: fp, content, stats, error: null as Error | null };
        } catch (err) {
          return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
        }
      }));

      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) { pool.shutdown(); return this.makeAbortResult(startTime, counters, errors); }
        onProgress?.({ phase: 'parsing', current: processed, total, currentFile: filePath });
        if (error || content === null || stats === null) {
          processed++;
          counters.filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath, severity: 'error', code: 'read_error',
          });
          continue;
        }
        const fileResult = await this.processFile(filePath, content, stats, pool, errors);
        processed++;
        if (fileResult.status === 'indexed') {
          counters.filesIndexed++;
          counters.totalNodes += fileResult.nodes;
          counters.totalEdges += fileResult.edges;
        } else if (fileResult.status === 'errored') {
          counters.filesErrored++;
        } else {
          counters.filesSkipped++;
        }
      }
    }

    onProgress?.({ phase: 'parsing', current: total, total });
    await new Promise(resolve => setImmediate(resolve));

    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );
    if (retryableErrors.length > 0 && WorkerClass) {
      const { nodesAdded, edgesAdded, errorsFixed } = await this.runRetryPass(pool, retryableErrors, signal, log);
      for (const e of errorsFixed) {
        const idx = errors.indexOf(e);
        if (idx >= 0) errors.splice(idx, 1);
      }
      counters.filesErrored -= errorsFixed.length;
      counters.filesIndexed += errorsFixed.length;
      counters.totalNodes += nodesAdded;
      counters.totalEdges += edgesAdded;
    }

    pool.shutdown();
    return {
      success: counters.filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed: counters.filesIndexed, filesSkipped: counters.filesSkipped, filesErrored: counters.filesErrored,
      nodesCreated: counters.totalNodes, edgesCreated: counters.totalEdges,
      errors, durationMs: Date.now() - startTime,
    };
  }

  private async runRetryPass(
    pool: WorkerPool,
    retryableErrors: ExtractionError[],
    signal: AbortSignal | undefined,
    log: (msg: string) => void
  ): Promise<{ nodesAdded: number; edgesAdded: number; errorsFixed: ExtractionError[] }> {
    let nodesAdded = 0;
    let edgesAdded = 0;
    const errorsFixed: ExtractionError[] = [];
    const stillFailing: ExtractionError[] = [];
    log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

    for (const errEntry of retryableErrors) {
      const filePath = errEntry.filePath!;
      if (signal?.aborted) break;
      pool.recycle();
      let content: string;
      try {
        const fullPath = validatePathWithinRoot(this.rootDir, filePath);
        if (!fullPath) continue;
        content = await fsp.readFile(fullPath, 'utf-8');
      } catch { continue; }
      let result: ExtractionResult;
      try {
        result = await pool.requestParse(filePath, content);
      } catch { stillFailing.push(errEntry); continue; }
      if (result.nodes.length > 0 || result.errors.length === 0) {
        const language = detectLanguage(filePath, content);
        const stats = await fsp.stat(path.join(this.rootDir, filePath));
        this.storeExtractionResult(filePath, content, language, stats, result);
        errorsFixed.push(errEntry);
        nodesAdded += result.nodes.length;
        edgesAdded += result.edges.length;
        log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
      }
    }

    if (stillFailing.length > 0) {
      log(`${stillFailing.length} files still failing — retrying with comments stripped...`);
      for (const errEntry of stillFailing) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;
        pool.recycle();
        let fullContent: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          fullContent = await fsp.readFile(fullPath, 'utf-8');
        } catch { continue; }
        const stripped = fullContent.split('\n').map(line => /^\s*\/\//.test(line) ? '' : line).join('\n');
        let result: ExtractionResult;
        try {
          result = await pool.requestParse(filePath, stripped);
        } catch { continue; }
        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, fullContent);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          this.storeExtractionResult(filePath, fullContent, language, stats, result);
          errorsFixed.push(errEntry);
          nodesAdded += result.nodes.length;
          edgesAdded += result.edges.length;
          log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }
    }

    return { nodesAdded, edgesAdded, errorsFixed };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Read file content and stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * Index a single file with pre-read content and stats.
   * Used by the parallel batch reader to avoid redundant file I/O.
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // Prevent path traversal
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > this.config.maxFileSize) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${this.config.maxFileSize})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source
    const result = extractFromSource(relativePath, content, language);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // No changes
    }

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Filter out nodes with missing required fields before insertion.
    // This prevents FK violations when edges reference nodes that would
    // be silently skipped by insertNode() (see issue #42).
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // Insert nodes
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // Filter edges to only reference nodes that were actually inserted
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // Insert unresolved references in batch with denormalized filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Sync with current file state.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars(); // Initialize WASM runtime (grammars loaded lazily below)
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    const gitChanges = getGitChangedFiles(this.rootDir, this.config);

    if (gitChanges) {
      // === Git fast path ===
      // Only inspect the files git reports as changed instead of scanning everything.
      filesChecked = gitChanges.modified.length + gitChanges.added.length + gitChanges.deleted.length;

      // Handle deleted files
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          this.queries.deleteFile(filePath);
          filesRemoved++;
        }
      }

      // Handle modified files — read + hash only these files
      for (const filePath of gitChanges.modified) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesAdded++;
        } else if (tracked.contentHash !== contentHash) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesModified++;
        }
      }

      // Handle added (untracked) files
      for (const filePath of gitChanges.added) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesAdded++;
      }
    } else {
      // === Fallback: full scan (non-git project or git failure) ===
      const currentFiles = new Set(scanDirectory(this.rootDir, this.config));
      filesChecked = currentFiles.size;

      // Build Map for O(1) lookups instead of .find() per file
      const trackedFiles = this.queries.getAllFiles();
      const trackedMap = new Map<string, FileRecord>();
      for (const f of trackedFiles) {
        trackedMap.set(f.path, f);
      }

      // Find files to remove (in DB but not on disk)
      for (const tracked of trackedFiles) {
        if (!currentFiles.has(tracked.path)) {
          this.queries.deleteFile(tracked.path);
          filesRemoved++;
        }
      }

      // Find files to add or update
      for (const filePath of currentFiles) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = trackedMap.get(filePath);

        if (!tracked) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesAdded++;
        } else if (tracked.contentHash !== contentHash) {
          filesToIndex.push(filePath);
          changedFilePaths.push(filePath);
          filesModified++;
        }
      }
    }

    // Load only grammars needed for changed files
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      // .h files default to 'c' but may be C++ — ensure cpp grammar is loaded
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    };
  }

  /**
   * Get files that have changed since last index.
   * Uses git status as a fast path when available, falling back to full scan.
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = getGitChangedFiles(this.rootDir, this.config);

    if (gitChanges) {
      // === Git fast path ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // Deleted files — only report if tracked in DB
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // Modified files — read + hash only these, compare with DB
      for (const filePath of gitChanges.modified) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      // Added (untracked) files
      for (const filePath of gitChanges.added) {
        added.push(filePath);
      }

      return { added, modified, removed };
    }

    // === Fallback: full scan (non-git project or git failure) ===
    const currentFiles = new Set(scanDirectory(this.rootDir, this.config));
    const trackedFiles = this.queries.getAllFiles();

    // Build Map for O(1) lookups
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './extract-dispatcher';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars, getGrammarError } from './grammars';
