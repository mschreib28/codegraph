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

  describe('Git submodule support', () => {
    let parentDir: string;
    let submoduleSrc: string;
    let cg: CodeGraph;

    function git(cwd: string, ...args: string[]) {
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    }

    beforeEach(async () => {
      parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-submod-parent-'));
      submoduleSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-submod-src-'));

      // Build the submodule's source repo first.
      git(submoduleSrc, 'init');
      git(submoduleSrc, 'config', 'user.email', 'test@test.com');
      git(submoduleSrc, 'config', 'user.name', 'Test');
      fs.writeFileSync(
        path.join(submoduleSrc, 'lib.ts'),
        `export function fromSubmodule() { return 'sub'; }`
      );
      git(submoduleSrc, 'add', '-A');
      git(submoduleSrc, 'commit', '-m', 'submodule initial');

      // Build the parent repo and add the submodule.
      git(parentDir, 'init');
      git(parentDir, 'config', 'user.email', 'test@test.com');
      git(parentDir, 'config', 'user.name', 'Test');

      const parentSrc = path.join(parentDir, 'src');
      fs.mkdirSync(parentSrc);
      fs.writeFileSync(
        path.join(parentSrc, 'main.ts'),
        `export function fromParent() { return 'parent'; }`
      );

      // git >= 2.38 blocks file:// submodule sources by default
      // (CVE-2022-39253). Pass via -c so it applies to this command only.
      git(parentDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSrc, 'vendor/sub');
      git(parentDir, 'add', '-A');
      git(parentDir, 'commit', '-m', 'parent initial with submodule');

      cg = CodeGraph.initSync(parentDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
    });

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(parentDir)) fs.rmSync(parentDir, { recursive: true, force: true });
      if (fs.existsSync(submoduleSrc)) fs.rmSync(submoduleSrc, { recursive: true, force: true });
    });

    it('should index files inside a submodule on full index', async () => {
      const result = await cg.indexAll();

      // Both the parent file and the submodule file should be indexed.
      expect(result.filesIndexed).toBeGreaterThanOrEqual(2);
      const subNodes = cg.searchNodes('fromSubmodule');
      const parentNodes = cg.searchNodes('fromParent');
      expect(subNodes.length).toBeGreaterThan(0);
      expect(parentNodes.length).toBeGreaterThan(0);
      // The submodule path should be reported relative to the parent root.
      expect(subNodes.some((r) => r.node.filePath.startsWith('vendor/sub/'))).toBe(true);
    });

    it('should detect modifications to files inside a submodule via sync', async () => {
      await cg.indexAll();

      fs.writeFileSync(
        path.join(parentDir, 'vendor/sub/lib.ts'),
        `export function fromSubmodule() { return 'changed'; }`
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('vendor/sub/lib.ts');
    });

    it('should detect new untracked files inside a submodule via sync', async () => {
      await cg.indexAll();

      fs.writeFileSync(
        path.join(parentDir, 'vendor/sub/newfile.ts'),
        `export function added() { return 1; }`
      );

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('vendor/sub/newfile.ts');
    });

    it('should not break when a submodule directory is missing or empty', async () => {
      // Wipe the submodule contents to mimic an unfetched submodule
      // (this isn't a real `git submodule deinit` — that would also remove
      // the .gitmodules entry — but it covers the common "directory exists,
      // no .git inside" failure mode). git ls-files inside the empty dir
      // errors; the scanner should swallow that and continue with parent files.
      fs.rmSync(path.join(parentDir, 'vendor/sub'), { recursive: true, force: true });
      fs.mkdirSync(path.join(parentDir, 'vendor/sub'));

      const result = await cg.indexAll();
      expect(result.errors.filter((e) => e.severity === 'error').length).toBe(0);
      expect(cg.searchNodes('fromParent').length).toBeGreaterThan(0);
    });

    it('should skip submodule contents when indexSubmodules is false', async () => {
      cg.destroy();
      fs.rmSync(path.join(parentDir, '.codegraph'), { recursive: true, force: true });
      cg = CodeGraph.initSync(parentDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
          indexSubmodules: false,
        },
      });

      const result = await cg.indexAll();
      expect(cg.searchNodes('fromParent').length).toBeGreaterThan(0);
      expect(cg.searchNodes('fromSubmodule').length).toBe(0);
      expect(result.filesIndexed).toBe(1);
    });
  });
});
