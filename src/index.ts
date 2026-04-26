/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as path from 'path';
import {
  CodeGraphConfig,
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import { loadConfig, saveConfig, createDefaultConfig } from './config';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { FileWatcher, WatchOptions } from './sync';
import { LlmClient, LlmEndpointConfig } from './llm/client';
import { summarizeAll, SUMMARIZABLE_KINDS } from './llm/summarizer';
import { embedAllSummaries } from './llm/embeddings';
import { askWithCandidates, AskOptions, AskResult } from './llm/ask';
import { detectLocalLlm, detectionToConfig } from './llm/detect';
import { logDebug, logWarn } from './errors';

// Re-export types for consumers
export * from './types';
export { getDatabasePath } from './db';
export { getConfigPath } from './config';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions } from './sync';
export { MCPServer } from './mcp';

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Custom configuration overrides */
  config?: Partial<CodeGraphConfig>;

  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;

  /**
   * After indexing/syncing, kick off LLM symbol summarisation in the
   * background if a local LLM is configured or auto-detectable.
   * Defaults to true. Set false in scripts / git hooks where the
   * caller doesn't want a long-running side effect.
   */
  summarize?: boolean;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private config: CodeGraphConfig;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  // Background LLM summarisation lifecycle
  private bgSummaryAbort: AbortController | null = null;
  private bgSummaryPromise: Promise<void> | null = null;
  // Set when an index/sync completes while a pass is already running.
  // The active pass checks this on completion and re-queues itself so
  // newly indexed symbols don't have to wait for the next sync to be
  // summarised.
  private bgSummaryDirty: boolean = false;
  // Auto-detected LLM config (populated lazily on first index/sync when
  // config.llm is absent). Cached per CodeGraph instance to avoid
  // probing localhost on every sync.
  private detectedLlmConfig: LlmEndpointConfig | null | undefined = undefined;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    config: CodeGraphConfig,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.config = config;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, config, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string, options: Omit<InitOptions, 'index' | 'onProgress'> = {}): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, config, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, config, resolvedRoot);
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Cancel any in-flight background summarisation. The signal is
    // checked between LLM requests; the in-flight HTTP call will
    // continue running but its result is dropped. Clear our promise
    // ref synchronously so isSummarizing() reflects cancellation
    // intent immediately.
    if (this.bgSummaryAbort) {
      this.bgSummaryAbort.abort();
      this.bgSummaryAbort = null;
    }
    this.bgSummaryPromise = null;
    this.bgSummaryDirty = false;
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Get the current configuration
   */
  getConfig(): CodeGraphConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CodeGraphConfig>): void {
    Object.assign(this.config, updates);
    saveConfig(this.projectRoot, this.config);
    // Recreate orchestrator and resolver with new config
    this.orchestrator = new ExtractionOrchestrator(
      this.projectRoot,
      this.config,
      this.queries
    );
    this.resolver = createResolver(this.projectRoot, this.queries);
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    const result = await this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

        // Resolve references to create call/import/extends edges
        if (result.success && result.filesIndexed > 0) {
          // Get count without loading all refs into memory
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });

    // Fire-and-forget background summarisation. Skipped silently when
    // no LLM is configured AND none is auto-detectable on localhost.
    if (result.success && result.filesIndexed > 0 && options.summarize !== false) {
      void this.startBackgroundSummarization();
    }
    return result;
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    const result = await this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });

    // Fire-and-forget background summarisation when files actually
    // changed. No-op on cold sync where nothing was added/modified.
    if ((result.filesAdded > 0 || result.filesModified > 0) && options.summarize !== false) {
      void this.startBackgroundSummarization();
    }
    return result;
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // LLM-driven enrichment
  // ===========================================================================

  /**
   * Resolve the LLM config to use: explicit config.llm wins; otherwise
   * probe the conventional Ollama endpoint and cache the result. The
   * probe is run once per CodeGraph instance — `null` is cached too, so
   * users without Ollama don't pay the localhost roundtrip on every
   * sync.
   *
   * Pass `forceRedetect: true` when the user has just installed Ollama
   * and wants codegraph to pick it up without restarting the process.
   */
  private async resolveLlmConfig(forceRedetect = false): Promise<LlmEndpointConfig | null> {
    if (this.config.llm?.endpoint && this.config.llm.chatModel) {
      return this.config.llm;
    }
    if (this.detectedLlmConfig !== undefined && !forceRedetect) {
      return this.detectedLlmConfig;
    }
    try {
      const detected = await detectLocalLlm();
      this.detectedLlmConfig = detected ? detectionToConfig(detected) : null;
      if (detected) {
        logDebug('Auto-detected local LLM', {
          endpoint: detected.endpoint,
          chatModel: detected.chatModel,
          embeddingModel: detected.embeddingModel,
        });
      }
    } catch (err) {
      // Detection must never throw into callers — treat any failure as
      // "no LLM available".
      this.detectedLlmConfig = null;
      logDebug('LLM auto-detect failed', { error: String(err) });
    }
    return this.detectedLlmConfig;
  }

  /**
   * Run a full symbol-summarisation pass over the indexed nodes via the
   * configured (or auto-detected) local LLM endpoint. Cached per node
   * by content_hash, so repeated calls only generate new/changed
   * summaries — first run is the slow one.
   *
   * Throws if no LLM is reachable. Use {@link hasLlm} (sync, config
   * only) or await {@link getEffectiveLlmConfig} (async, includes
   * auto-detect) before calling.
   */
  async summarizeAll(options: {
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
    concurrency?: number;
  } = {}): Promise<{ candidates: number; generated: number; cacheHits: number; errors: number; durationMs: number }> {
    const llmConfig = await this.resolveLlmConfig();
    if (!llmConfig) {
      throw new Error(
        'No LLM available. Configure config.llm.endpoint or run a local Ollama server with a chat model installed.'
      );
    }
    const client = new LlmClient(llmConfig);
    const reachable = await client.isReachable();
    if (!reachable) {
      throw new Error(`LLM endpoint not reachable at ${llmConfig.endpoint}. Is your local server running?`);
    }
    return summarizeAll(this.projectRoot, this.queries, client, llmConfig.chatModel!, options);
  }

  /**
   * Whether an LLM endpoint is configured in `config.llm`. This is the
   * synchronous check — it does NOT trigger auto-detection. Callers
   * that want to know whether summaries are *possible* (config OR
   * auto-detect) should `await getEffectiveLlmConfig()` instead.
   */
  hasLlm(): boolean {
    return Boolean(this.config.llm?.endpoint && this.config.llm.chatModel);
  }

  /**
   * Returns the LLM config that will be used, including auto-detection.
   * Callers can use this to decide whether to surface LLM-dependent UI
   * without writing it to disk.
   */
  async getEffectiveLlmConfig(): Promise<LlmEndpointConfig | null> {
    return this.resolveLlmConfig();
  }

  /**
   * Kick off a summarisation pass in the background. Returns
   * immediately — does NOT block the caller. Subsequent calls while
   * one is already running are no-ops (returns the existing promise).
   *
   * The pass is best-effort: errors are logged, never thrown. The
   * promise resolves either when work completes or when {@link close}
   * cancels via AbortController.
   *
   * Called automatically after `indexAll` and `sync` so the user gets
   * summaries without having to invoke a CLI command.
   */
  startBackgroundSummarization(): Promise<void> {
    if (this.bgSummaryPromise) {
      // Mark dirty so the running pass re-queues itself once it
      // finishes — newly indexed symbols will be picked up without
      // needing another sync to land.
      this.bgSummaryDirty = true;
      return this.bgSummaryPromise;
    }

    const controller = new AbortController();
    this.bgSummaryAbort = controller;
    this.bgSummaryDirty = false;

    const run = async (): Promise<void> => {
      try {
        const llmConfig = await this.resolveLlmConfig();
        if (!llmConfig || controller.signal.aborted) return;

        const client = new LlmClient(llmConfig);
        if (!(await client.isReachable())) {
          logDebug('Background summarisation: endpoint went away', {
            endpoint: llmConfig.endpoint,
          });
          return;
        }

        const result = await summarizeAll(
          this.projectRoot,
          this.queries,
          client,
          llmConfig.chatModel!,
          { signal: controller.signal, concurrency: 2 }
        );
        logDebug('Background summarisation complete', {
          candidates: result.candidates,
          generated: result.generated,
          cacheHits: result.cacheHits,
          errors: result.errors,
          durationMs: result.durationMs,
        });

        // Phase-2: embed the summaries so semantic search has data.
        // Only runs when an embedding model is configured/auto-detected.
        if (llmConfig.embeddingModel && !controller.signal.aborted) {
          const eResult = await embedAllSummaries(
            this.queries,
            client,
            llmConfig.embeddingModel,
            { signal: controller.signal, concurrency: 2 }
          );
          logDebug('Background embedding complete', {
            candidates: eResult.candidates,
            generated: eResult.generated,
            errors: eResult.errors,
            durationMs: eResult.durationMs,
          });
        }
      } catch (err) {
        // Background work must not crash the host process. Worst case
        // is no summaries — the rest of codegraph still works.
        logWarn('Background summarisation failed', { error: String(err) });
      } finally {
        // Only clear our refs if we still own them. close() may have
        // already cancelled and a fresh pass may have been started in
        // the interim — don't clobber its bookkeeping.
        if (this.bgSummaryAbort === controller) {
          this.bgSummaryAbort = null;
        }
        if (this.bgSummaryPromise === pending) {
          this.bgSummaryPromise = null;
          // Re-queue if more work landed during the pass and we
          // weren't aborted — gives newly indexed symbols a fast
          // path without waiting for the next sync.
          if (this.bgSummaryDirty && !controller.signal.aborted) {
            this.bgSummaryDirty = false;
            void this.startBackgroundSummarization();
          }
        }
      }
    };

    const pending = run();
    this.bgSummaryPromise = pending;
    return pending;
  }

  /** Whether a background summarisation pass is currently running. */
  isSummarizing(): boolean {
    return this.bgSummaryPromise !== null;
  }

  /**
   * Wait for any background summarisation to finish. Useful in tests
   * and short-lived CLI invocations that want summaries persisted
   * before exit.
   */
  async awaitBackgroundSummarization(): Promise<void> {
    if (this.bgSummaryPromise) await this.bgSummaryPromise;
  }

  /**
   * Coverage stats: how many indexed symbols have a cached LLM summary.
   * Surfaces in `codegraph status` and helps users understand why some
   * tool outputs include summaries and others don't.
   */
  getSummaryCoverage(): { total: number; summarised: number } {
    return this.queries.getSummaryCoverage(SUMMARIZABLE_KINDS);
  }

  /**
   * Bulk-fetch cached summaries for a set of node ids. Used by MCP
   * tools and the CLI to enrich result lists with one-line descriptions
   * without exposing the database layer.
   */
  getSymbolSummaries(nodeIds: string[]): Map<string, string> {
    if (nodeIds.length === 0) return new Map();
    return this.queries.getSymbolSummaries(nodeIds);
  }

  /**
   * Natural-language Q&A over the codebase. Hybrid-retrieves the
   * top-K most relevant symbols, builds a context prompt, and asks
   * the configured/auto-detected chat model.
   *
   * Throws if no LLM is reachable. Use {@link getEffectiveLlmConfig}
   * to check before calling for a graceful UX.
   */
  async ask(question: string, options: AskOptions = {}): Promise<AskResult> {
    const llmConfig = await this.resolveLlmConfig();
    if (!llmConfig?.chatModel) {
      throw new Error(
        'No LLM available for codegraph_ask. Configure config.llm or run a local Ollama server with a chat model installed.'
      );
    }
    const client = new LlmClient(llmConfig);
    if (!(await client.isReachable())) {
      throw new Error(`LLM endpoint not reachable at ${llmConfig.endpoint}`);
    }

    const k = options.retrieveK ?? 12;
    const candidates = await this.searchHybrid(question, { limit: k });
    return askWithCandidates(
      this.projectRoot,
      question,
      candidates,
      this.queries,
      client,
      llmConfig.chatModel,
      options
    );
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      this.config,
      async () => {
        const result = await this.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * Hybrid search: blends FTS5 lexical results with cosine semantic
   * results via Reciprocal Rank Fusion. Falls back to FTS-only when
   * no embedding model is configured/auto-detected, so callers can
   * always use this — it just gets smarter as enrichment lands.
   *
   * The semantic ranking comes from the LLM-generated symbol summaries
   * (PR #111) embedded with the auto-detected embedding model
   * (PR #112 / Phase 0). Cold codebases without summaries fall through
   * to FTS-only with no quality regression.
   */
  async searchHybrid(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = options?.limit ?? 20;
    // Pull a deeper FTS slice than the user wants because RRF blending
    // needs candidates beyond the first cut.
    const ftsResults = this.queries.searchNodes(query, { ...options, limit: Math.max(50, limit * 3) });

    const llmConfig = await this.resolveLlmConfig();
    if (!llmConfig?.embeddingModel) {
      return ftsResults.slice(0, limit);
    }

    // Cheap reachability check — if the endpoint is gone we still
    // have valid FTS results to return rather than failing the call.
    const client = new LlmClient(llmConfig);
    if (!(await client.isReachable())) {
      return ftsResults.slice(0, limit);
    }

    let queryVec: Float32Array;
    try {
      const vecs = await client.embed([query]);
      if (vecs.length === 0 || !vecs[0]) return ftsResults.slice(0, limit);
      queryVec = vecs[0];
    } catch (err) {
      logDebug('Hybrid search: query embed failed, falling back to FTS', { error: String(err) });
      return ftsResults.slice(0, limit);
    }

    const allEmbeddings = this.queries.getAllEmbeddings(llmConfig.embeddingModel);
    if (allEmbeddings.length === 0) {
      return ftsResults.slice(0, limit);
    }

    const { topKByCosine, reciprocalRankFusion } = await import('./llm/embeddings');
    const semanticHits = topKByCosine(queryVec, allEmbeddings, Math.max(50, limit * 3));

    // Build the two ranking lists for RRF, both keyed by node id.
    const ftsRanked = ftsResults.map((r) => ({ id: r.node.id }));
    const semRanked = semanticHits.map((h) => ({ id: h.nodeId }));
    const fused = reciprocalRankFusion([ftsRanked, semRanked]);

    // Map every id we know about back to a SearchResult. FTS results
    // already carry node objects; semantic-only hits need a lookup.
    const known = new Map<string, SearchResult>();
    for (const r of ftsResults) known.set(r.node.id, r);

    const orderedIds = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const out: SearchResult[] = [];
    for (const id of orderedIds) {
      if (out.length >= limit) break;
      let result = known.get(id);
      if (!result) {
        const node = this.queries.getNodeById(id);
        if (!node) continue;
        result = { node, score: fused.get(id) ?? 0 };
      }
      out.push(result);
    }
    return out;
  }

  /**
   * Find symbols whose meaning is similar to a given node, via
   * embedding cosine. Useful for "show me the other functions doing
   * the same thing" — including across languages, since summaries
   * are language-agnostic.
   */
  async findSimilar(
    nodeId: string,
    options: { limit?: number; sameLanguage?: boolean; differentLanguage?: boolean } = {}
  ): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    const llmConfig = await this.resolveLlmConfig();
    if (!llmConfig?.embeddingModel) return [];

    // Need the source node + its own embedding to compare against.
    const sourceNode = this.queries.getNodeById(nodeId);
    if (!sourceNode) return [];

    const all = this.queries.getAllEmbeddings(llmConfig.embeddingModel);
    const sourceRow = all.find((r) => r.nodeId === nodeId);
    if (!sourceRow) return [];

    const { bytesToVector, topKByCosine } = await import('./llm/embeddings');
    const sourceVec = bytesToVector(sourceRow.embedding);
    // Skip the source itself by filtering after top-k (cheap with a
    // small post-filter; a larger k+1 lets us guarantee `limit` survivors).
    const hits = topKByCosine(sourceVec, all, limit + 1).filter((h) => h.nodeId !== nodeId);

    const out: SearchResult[] = [];
    for (const hit of hits) {
      if (out.length >= limit) break;
      const node = this.queries.getNodeById(hit.nodeId);
      if (!node) continue;
      if (options.sameLanguage && node.language !== sourceNode.language) continue;
      if (options.differentLanguage && node.language === sourceNode.language) continue;
      out.push({ node, score: hit.score });
    }
    return out;
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
