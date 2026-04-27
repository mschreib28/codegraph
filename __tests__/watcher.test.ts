/**
 * FileWatcher Tests
 *
 * Tests for the file watcher that auto-syncs on changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileWatcher } from '../src/sync/watcher';
import type { CodeGraphConfig } from '../src/types';
import CodeGraph from '../src/index';

/**
 * Helper to wait for a condition with timeout
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * fs.watch on macOS (FSEvents) and Linux (inotify) has a small but real
 * latency between `fs.watch()` returning and the kernel actually
 * delivering events. Writing a file in that window — particularly under
 * parallel test load when the host CPU is busy — drops the event and
 * causes a 5s timeout for "should trigger sync after file change" style
 * tests. This helper standardizes the settle delay to match the pattern
 * already used by the filtering tests in this file.
 */
async function letWatcherSettle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
}

describe('FileWatcher', () => {
  let testDir: string;

  const baseConfig: CodeGraphConfig = {
    version: 1,
    rootDir: '.',
    include: ['**/*.ts', '**/*.js'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    languages: [],
    frameworks: [],
    maxFileSize: 1024 * 1024,
    extractDocstrings: true,
    trackCallSites: true,
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-watcher-'));
    // Create a source file so the directory isn't empty
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('start/stop lifecycle', () => {
    it('should start and stop without errors', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn);

      const started = watcher.start();
      expect(started).toBe(true);
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
      expect(watcher.isActive()).toBe(false);
    });

    it('should be idempotent on double start', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn);

      expect(watcher.start()).toBe(true);
      expect(watcher.start()).toBe(true); // Should not throw
      expect(watcher.isActive()).toBe(true);

      watcher.stop();
    });

    it('should be idempotent on double stop', () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn);

      watcher.start();
      watcher.stop();
      watcher.stop(); // Should not throw
      expect(watcher.isActive()).toBe(false);
    });
  });

  describe('debounced sync', () => {
    it('should trigger sync after file change', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, { debounceMs: 200 });

      watcher.start();
      await letWatcherSettle();

      // Create a new file
      fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), 'export const y = 2;');

      // Wait for debounced sync to fire
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);
      expect(syncFn).toHaveBeenCalled();

      watcher.stop();
    });

    it('should debounce rapid changes into a single sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 1, durationMs: 10 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, { debounceMs: 500 });

      watcher.start();
      await letWatcherSettle();

      // Rapid-fire changes
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(testDir, 'src', `file${i}.ts`),
          `export const v${i} = ${i};`
        );
        await new Promise((r) => setTimeout(r, 50));
      }

      // Wait for the single debounced sync
      await waitFor(() => syncFn.mock.calls.length > 0, 5000);

      // Should have been called once (debounced), not 5 times
      expect(syncFn.mock.calls.length).toBe(1);

      watcher.stop();
    });
  });

  describe('filtering', () => {
    it('should ignore files not matching include patterns', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await letWatcherSettle();
      syncFn.mockClear();

      // Create a file that doesn't match include patterns
      fs.writeFileSync(path.join(testDir, 'src', 'readme.md'), '# Hello');

      // Wait a bit longer than debounce — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });

    it('should ignore .codegraph directory changes', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 0, durationMs: 0 });
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, { debounceMs: 200 });

      watcher.start();

      // Let watcher settle — fs.watch may fire residual events from beforeEach
      await letWatcherSettle();
      syncFn.mockClear();

      // Simulate a .codegraph directory change
      const cgDir = path.join(testDir, '.codegraph');
      fs.mkdirSync(cgDir, { recursive: true });
      fs.writeFileSync(path.join(cgDir, 'db.sqlite'), 'fake');

      // Wait — sync should NOT trigger
      await new Promise((r) => setTimeout(r, 500));
      expect(syncFn).not.toHaveBeenCalled();

      watcher.stop();
    });
  });

  describe('callbacks', () => {
    it('should call onSyncComplete after successful sync', async () => {
      const syncFn = vi.fn().mockResolvedValue({ filesChanged: 2, durationMs: 50 });
      const onSyncComplete = vi.fn();
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, {
        debounceMs: 200,
        onSyncComplete,
      });

      watcher.start();
      await letWatcherSettle();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 5000);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 2, durationMs: 50 });

      watcher.stop();
    });

    it('should call onSyncError when sync throws', async () => {
      const syncFn = vi.fn().mockRejectedValue(new Error('sync failed'));
      const onSyncError = vi.fn();
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, {
        debounceMs: 200,
        onSyncError,
      });

      watcher.start();
      await letWatcherSettle();

      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncError.mock.calls.length > 0, 5000);
      expect(onSyncError).toHaveBeenCalled();
      expect(onSyncError.mock.calls[0]![0]).toBeInstanceOf(Error);

      watcher.stop();
    });

    it('should retry pending changes after a sync failure (no events lost)', async () => {
      // First call rejects, subsequent calls resolve. After the initial
      // failure, the watcher should retry the same batch on its own — without
      // this, transient sync failures (DB locked etc.) would silently drop the
      // changes until a new file event happened.
      let calls = 0;
      const syncFn = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('transient'));
        return Promise.resolve({ filesChanged: 1, durationMs: 5 });
      });
      const onSyncError = vi.fn();
      const onSyncComplete = vi.fn();
      const watcher = new FileWatcher(testDir, baseConfig, syncFn, {
        debounceMs: 100,
        onSyncError,
        onSyncComplete,
      });

      watcher.start();
      fs.writeFileSync(path.join(testDir, 'src', 'test.ts'), 'export const z = 3;');

      await waitFor(() => onSyncComplete.mock.calls.length > 0, 5000);
      expect(onSyncError).toHaveBeenCalledTimes(1);
      expect(syncFn).toHaveBeenCalledTimes(2);
      expect(onSyncComplete).toHaveBeenCalledWith({ filesChanged: 1, durationMs: 5 });

      watcher.stop();
    });
  });

  describe('CodeGraph integration', () => {
    let cg: CodeGraph;

    afterEach(() => {
      if (cg) cg.close();
    });

    it('should watch and unwatch via CodeGraph API', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      expect(cg.isWatching()).toBe(false);

      const started = cg.watch({ debounceMs: 200 });
      expect(started).toBe(true);
      expect(cg.isWatching()).toBe(true);

      cg.unwatch();
      expect(cg.isWatching()).toBe(false);
    });

    it('should stop watching on close', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      cg.watch({ debounceMs: 200 });
      expect(cg.isWatching()).toBe(true);

      cg.close();
      // After close, isWatching should be false
      // (we can't call isWatching after close since DB is closed,
      //  but we verify no errors are thrown)
    });

    it('should auto-sync when files change while watching', async () => {
      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();

      const initialStats = cg.getStats();
      const initialNodes = initialStats.nodeCount;

      cg.watch({ debounceMs: 300 });
      await letWatcherSettle();

      // Add a new file with a function
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        'export function added() { return 42; }'
      );

      // Wait for auto-sync to pick it up
      await waitFor(() => {
        const stats = cg.getStats();
        return stats.nodeCount > initialNodes;
      }, 10000);

      // The new function should be in the graph
      const results = cg.searchNodes('added');
      expect(results.length).toBeGreaterThan(0);

      cg.unwatch();
    });
  });
});
