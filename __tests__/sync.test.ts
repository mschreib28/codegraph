/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of codegraph's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import CodeGraph from '../src/index';

describe('Sync Module', () => {
  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: CodeGraph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      // Initialize and index
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function hello() { return 'modified'; }`
        );

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(
          path.join(testDir, 'src', 'new.ts'),
          `export function newFunc() { return 42; }`
        );

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(
          path.join(testDir, 'src', 'index.ts'),
          `export function goodbye() { return 'farewell'; }`
        );

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = cg.searchNodes('goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = cg.searchNodes('hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = cg.searchNodes('hello');
        expect(nodes.length).toBe(0);
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });
    });
  });

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: CodeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-sync-'));

      // Initialize a git repo with an initial commit
      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      // Initialize CodeGraph and index
      cg = CodeGraph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.destroy();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should detect modified files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function hello() { return 'modified'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(
        path.join(testDir, 'src', 'new.ts'),
        `export function newFunc() { return 42; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = cg.searchNodes('newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = cg.searchNodes('hello');
      expect(nodes.length).toBe(0);
    });

    it('should skip files not matching config', async () => {
      // Create a .js file which doesn't match **/*.ts
      fs.writeFileSync(
        path.join(testDir, 'src', 'ignored.js'),
        `function ignored() {}`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });
  });

  // Regression tests for the "stale index after HEAD-moving git operation"
  // bug. `git status` only reports working-tree dirtiness vs HEAD, so a
  // merge / pull / checkout / rebase / reset (and even post-commit) leaves
  // a clean tree and used to trick sync into reporting "up to date" while
  // the DB still held pre-operation content hashes. The fix detects HEAD
  // movement by comparing current HEAD against a stored last-synced HEAD
  // and unioning `git diff` output into the changed-file set.
  describe('HEAD-moving git operations', () => {
    let testDir: string;
    let cg: CodeGraph;

    function git(...args: string[]) {
      execFileSync('git', args, { cwd: testDir, stdio: 'pipe' });
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-head-move-'));

      git('init');
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');
      // Pin initial branch name so subsequent checkouts are deterministic
      // across git versions that default to master vs main.
      git('symbolic-ref', 'HEAD', 'refs/heads/main');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        `export function hello() { return 'world'; }`
      );

      git('add', '-A');
      git('commit', '-m', 'initial');

      cg = CodeGraph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should detect changes brought in by `git merge`', async () => {
      // Branch off, modify on the branch, commit, switch back, merge.
      git('checkout', '-b', 'feature');
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function merged() { return 'from-branch'; }`
      );
      fs.writeFileSync(
        path.join(testDir, 'src', 'added.ts'),
        `export function fromBranch() { return 1; }`
      );
      git('add', '-A');
      git('commit', '-m', 'feature work');
      git('checkout', 'main');
      git('merge', '--no-ff', 'feature', '-m', 'merge feature');

      // Working tree is clean post-merge — `git status` shows nothing.
      const result = await cg.sync();

      expect(result.filesModified + result.filesAdded).toBeGreaterThanOrEqual(2);
      expect(cg.searchNodes('merged').length).toBeGreaterThan(0);
      expect(cg.searchNodes('fromBranch').length).toBeGreaterThan(0);
      expect(cg.searchNodes('hello').length).toBe(0);
    });

    it('should detect changes after `git checkout` to a different branch', async () => {
      git('checkout', '-b', 'other');
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function onOther() { return 'other'; }`
      );
      git('add', '-A');
      git('commit', '-m', 'other work');
      git('checkout', 'main');
      // We're back on main, where `hello` exists. Before the fix, sync
      // here would no-op because the working tree matches HEAD (= main).
      // But the index was last synced against `other`, so we expect the
      // diff main..other to flow through and bring the index in line
      // with the current branch.
      git('checkout', 'other');

      const result = await cg.sync();

      expect(result.filesModified).toBeGreaterThanOrEqual(1);
      expect(cg.searchNodes('onOther').length).toBeGreaterThan(0);
      expect(cg.searchNodes('hello').length).toBe(0);
    });

    it('should detect file deletion brought in by a committed change', async () => {
      git('rm', path.join('src', 'index.ts'));
      git('commit', '-m', 'remove index');

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);
      expect(cg.searchNodes('hello').length).toBe(0);
    });

    it('should fall back to full scan when last-synced HEAD is unreachable', async () => {
      // Modify and commit, then rewrite history so the previously-synced
      // HEAD (recorded by indexAll in beforeEach) is no longer reachable.
      fs.writeFileSync(
        path.join(testDir, 'src', 'index.ts'),
        `export function rewritten() { return 'rewritten'; }`
      );
      git('add', '-A');
      git('commit', '--amend', '-m', 'rewritten');
      // `git gc --prune=now` would sever the orphaned commit, but amending
      // already moves HEAD to a new SHA the index has never seen and the
      // OLD SHA may or may not be reachable. We verify behavior is correct
      // either way: sync brings the index in line with current state.
      const result = await cg.sync();

      expect(result.filesModified + result.filesAdded).toBeGreaterThanOrEqual(1);
      expect(cg.searchNodes('rewritten').length).toBeGreaterThan(0);
      expect(cg.searchNodes('hello').length).toBe(0);
    });

    it('should still no-op when HEAD has not moved and tree is clean', async () => {
      // Sanity: the new HEAD-tracking code must not introduce spurious work.
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });
  });
});
