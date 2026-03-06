/**
 * Installer Tests
 *
 * Tests for installer config-writer fixes:
 * - readJsonFile error handling
 * - writeClaudeMd section replacement
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the exported functions from config-writer
import {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  writeHooks,
  hasClaudeMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
  writeCursorMcpConfig,
  writeCursorRules,
  hasCursorMcpConfig,
} from '../src/installer/config-writer';
import type { InstallLocation } from '../src/installer/prompts';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-installer-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * E2E Test helper utilities
 */
class InstallerTestHelper {
  private origCwd: string;
  private tempDir: string;
  private origHome: string | undefined;

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-e2e-'));
    this.origCwd = process.cwd();
    this.origHome = process.env.HOME;
  }

  /**
   * Setup test environment
   */
  setup() {
    process.chdir(this.tempDir);
    // Override HOME for global installs during tests
    process.env.HOME = this.tempDir;
  }

  /**
   * Cleanup test environment
   */
  cleanup() {
    process.chdir(this.origCwd);
    if (this.origHome !== undefined) {
      process.env.HOME = this.origHome;
    }
    if (fs.existsSync(this.tempDir)) {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Verify Claude Code installation files
   */
  verifyClaudeInstall(location: InstallLocation) {
    const baseDir = location === 'global' ? this.tempDir : process.cwd();

    // Check .claude.json
    const claudeJsonPath = path.join(baseDir, '.claude.json');
    expect(fs.existsSync(claudeJsonPath), `${claudeJsonPath} should exist`).toBe(true);

    const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
    expect(claudeJson.mcpServers?.codegraph, 'MCP server config should exist').toBeDefined();
    expect(claudeJson.mcpServers.codegraph.command).toBe('codegraph');
    expect(claudeJson.mcpServers.codegraph.args).toEqual(['serve', '--mcp']);

    // Check .claude/settings.json (for hooks)
    const settingsPath = path.join(baseDir, '.claude', 'settings.json');
    expect(fs.existsSync(settingsPath), `${settingsPath} should exist`).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks, 'Hooks should exist').toBeDefined();
    expect(JSON.stringify(settings.hooks)).toContain('codegraph');

    // Check CLAUDE.md
    const claudeMdPath = path.join(baseDir, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath), `${claudeMdPath} should exist`).toBe(true);

    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd).toContain('## CodeGraph');
    expect(claudeMd).toContain('<!-- CODEGRAPH_START -->');
    expect(claudeMd).toContain('codegraph_search');
  }

  /**
   * Verify Cursor installation files
   */
  verifyCursorInstall() {
    // Check .cursor/mcp.json
    const mcpJsonPath = path.join(process.cwd(), '.cursor', 'mcp.json');
    expect(fs.existsSync(mcpJsonPath), `${mcpJsonPath} should exist`).toBe(true);

    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    expect(mcpJson.mcpServers?.codegraph, 'MCP server config should exist').toBeDefined();
    expect(mcpJson.mcpServers.codegraph.command).toBe('codegraph');

    // Check .cursor/rules/codegraph.md
    const rulesPath = path.join(process.cwd(), '.cursor', 'rules', 'codegraph.md');
    expect(fs.existsSync(rulesPath), `${rulesPath} should exist`).toBe(true);

    const rules = fs.readFileSync(rulesPath, 'utf-8');
    expect(rules).toContain('## CodeGraph');
    expect(rules).toContain('codegraph_search');
    expect(rules).toContain('Agent mode');
    expect(rules).not.toContain('<!-- CODEGRAPH_START -->'); // No markers for Cursor
  }

  /**
   * Verify files do NOT exist
   */
  verifyClaudeNotInstalled(location: InstallLocation) {
    const baseDir = location === 'global' ? this.tempDir : process.cwd();
    const claudeJsonPath = path.join(baseDir, '.claude.json');
    expect(fs.existsSync(claudeJsonPath)).toBe(false);
  }

  verifyCursorNotInstalled() {
    const mcpJsonPath = path.join(process.cwd(), '.cursor', 'mcp.json');
    expect(fs.existsSync(mcpJsonPath)).toBe(false);
  }
}

describe('Installer Config Writer', () => {
  let origCwd: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    origCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    cleanupTempDir(tempDir);
  });

  describe('readJsonFile error handling', () => {
    it('should return empty object for non-existent file', () => {
      // writeMcpConfig reads claude.json - if it doesn't exist, it should create it
      writeMcpConfig('local');

      const claudeJson = path.join(tempDir, '.claude.json');
      expect(fs.existsSync(claudeJson)).toBe(true);

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers).toBeDefined();
      expect(content.mcpServers.codegraph).toBeDefined();
    });

    it('should handle corrupted JSON by creating backup', () => {
      // Create a corrupted claude.json
      const claudeJson = path.join(tempDir, '.claude.json');
      fs.writeFileSync(claudeJson, '{ this is not valid json !!!');

      // Suppress console.warn during test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Should not throw - gracefully handles corruption
      writeMcpConfig('local');

      // Should have warned
      expect(warnSpy).toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls[0][0];
      expect(warnMsg).toContain('Warning');

      // Backup should exist
      expect(fs.existsSync(claudeJson + '.backup')).toBe(true);
      // Original backup content should be the corrupted content
      const backup = fs.readFileSync(claudeJson + '.backup', 'utf-8');
      expect(backup).toContain('this is not valid json');

      // New file should be valid JSON with codegraph config
      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();

      warnSpy.mockRestore();
    });

    it('should preserve existing valid config when adding codegraph', () => {
      const claudeJson = path.join(tempDir, '.claude.json');
      fs.writeFileSync(claudeJson, JSON.stringify({
        mcpServers: { other: { command: 'other-tool' } },
        customField: 'preserved',
      }, null, 2));

      writeMcpConfig('local');

      const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
      expect(content.mcpServers.codegraph).toBeDefined();
      expect(content.mcpServers.other).toBeDefined();
      expect(content.customField).toBe('preserved');
    });
  });

  describe('writeClaudeMd section replacement', () => {
    it('should create new CLAUDE.md with markers', () => {
      const result = writeClaudeMd('local');

      expect(result.created).toBe(true);
      const content = fs.readFileSync(path.join(tempDir, '.claude', 'CLAUDE.md'), 'utf-8');
      expect(content).toContain('<!-- CODEGRAPH_START -->');
      expect(content).toContain('<!-- CODEGRAPH_END -->');
      expect(content).toContain('## CodeGraph');
    });

    it('should replace marked section on update', () => {
      // First write
      writeClaudeMd('local');

      // Modify file to add custom content before and after
      const claudeMdPath = path.join(tempDir, '.claude', 'CLAUDE.md');
      const original = fs.readFileSync(claudeMdPath, 'utf-8');
      const modified = '## My Custom Section\n\nCustom content\n\n' + original + '\n\n## Another Section\n\nMore content\n';
      fs.writeFileSync(claudeMdPath, modified);

      // Second write should replace only the marked section
      const result = writeClaudeMd('local');
      expect(result.updated).toBe(true);

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(final).toContain('## My Custom Section');
      expect(final).toContain('Custom content');
      expect(final).toContain('## Another Section');
      expect(final).toContain('More content');
      expect(final).toContain('## CodeGraph');
    });

    it('should use atomic writes (no temp files left behind)', () => {
      writeClaudeMd('local');

      const claudeDir = path.join(tempDir, '.claude');
      const files = fs.readdirSync(claudeDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('should not overwrite content after unmarked section with ### subsections', () => {
      // Create a CLAUDE.md with an unmarked CodeGraph section that has ### subsections
      // followed by another ## section
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, [
        '## Pre-existing Section',
        '',
        'Some content',
        '',
        '## CodeGraph',
        '',
        '### Subsection A',
        '',
        'Old codegraph content',
        '',
        '### Subsection B',
        '',
        'More old content',
        '',
        '## Important Section After',
        '',
        'This content must not be overwritten!',
        '',
      ].join('\n'));

      const result = writeClaudeMd('local');
      expect(result.updated).toBe(true);

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      // The section after CodeGraph must be preserved
      expect(final).toContain('## Important Section After');
      expect(final).toContain('This content must not be overwritten!');
      // Pre-existing section should also be preserved
      expect(final).toContain('## Pre-existing Section');
      // New CodeGraph content should be present with markers
      expect(final).toContain('<!-- CODEGRAPH_START -->');
      expect(final).toContain('<!-- CODEGRAPH_END -->');
    });

    it('should replace unmarked section without subsections', () => {
      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      // Note: regex needs \n before ## CodeGraph, so prefix with another section
      fs.writeFileSync(claudeMdPath, [
        '## Intro',
        '',
        'Preamble',
        '',
        '## CodeGraph',
        '',
        'Old simple content',
        '',
        '## Next Section',
        '',
        'Must be preserved',
        '',
      ].join('\n'));

      writeClaudeMd('local');

      const final = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(final).toContain('<!-- CODEGRAPH_START -->');
      expect(final).toContain('## Next Section');
      expect(final).toContain('Must be preserved');
      expect(final).not.toContain('Old simple content');
    });
  });
});

/**
 * End-to-End Installer Tests
 *
 * Tests all combinations of IDE installations:
 * - Claude Code only (global)
 * - Claude Code only (local)
 * - Cursor only (local)
 * - Both IDEs (local)
 */
describe('Installer E2E Tests', () => {
  let helper: InstallerTestHelper;

  beforeEach(() => {
    helper = new InstallerTestHelper();
    helper.setup();
  });

  afterEach(() => {
    helper.cleanup();
  });

  describe('Claude Code Only - Global', () => {
    it('should install Claude Code globally', () => {
      const location: InstallLocation = 'global';

      // Simulate full installation
      writeMcpConfig(location);
      writePermissions(location);
      writeHooks(location);
      writeClaudeMd(location);

      // Verify installation
      helper.verifyClaudeInstall(location);
      helper.verifyCursorNotInstalled();

      // Verify detection
      expect(hasClaudeMcpConfig(location)).toBe(true);
      expect(hasCursorMcpConfig()).toBe(false);
    });
  });

  describe('Claude Code Only - Local', () => {
    it('should install Claude Code locally', () => {
      const location: InstallLocation = 'local';

      // Simulate full installation
      writeMcpConfig(location);
      writePermissions(location);
      writeHooks(location);
      writeClaudeMd(location);

      // Verify installation
      helper.verifyClaudeInstall(location);
      helper.verifyCursorNotInstalled();

      // Verify detection
      expect(hasClaudeMcpConfig(location)).toBe(true);
      expect(hasCursorMcpConfig()).toBe(false);
    });
  });

  describe('Cursor Only', () => {
    it('should install Cursor locally', () => {
      // Cursor only supports local
      writeCursorMcpConfig();
      writeCursorRules();

      // Verify installation
      helper.verifyCursorInstall();
      helper.verifyClaudeNotInstalled('local');
      helper.verifyClaudeNotInstalled('global');

      // Verify detection
      expect(hasCursorMcpConfig()).toBe(true);
      expect(hasClaudeMcpConfig('local')).toBe(false);
    });
  });

  describe('Both IDEs - Local', () => {
    it('should install both Claude Code and Cursor locally', () => {
      const location: InstallLocation = 'local';

      // Install Claude Code
      writeMcpConfig(location);
      writePermissions(location);
      writeHooks(location);
      writeClaudeMd(location);

      // Install Cursor
      writeCursorMcpConfig();
      writeCursorRules();

      // Verify both installations
      helper.verifyClaudeInstall(location);
      helper.verifyCursorInstall();

      // Verify detection
      expect(hasClaudeMcpConfig(location)).toBe(true);
      expect(hasCursorMcpConfig()).toBe(true);
    });
  });

  describe('Update Scenarios', () => {
    it('should update existing Claude Code installation', () => {
      const location: InstallLocation = 'local';

      // First install
      writeMcpConfig(location);
      writeClaudeMd(location);

      const claudeMdPath = path.join(process.cwd(), '.claude', 'CLAUDE.md');
      const firstContent = fs.readFileSync(claudeMdPath, 'utf-8');

      // Second install (update)
      writeMcpConfig(location);
      writeClaudeMd(location);

      const secondContent = fs.readFileSync(claudeMdPath, 'utf-8');

      // Content should be updated but structure preserved
      expect(secondContent).toContain('<!-- CODEGRAPH_START -->');
      expect(secondContent).toContain('## CodeGraph');
    });

    it('should update existing Cursor installation', () => {
      // First install
      writeCursorMcpConfig();
      writeCursorRules();

      const rulesPath = path.join(process.cwd(), '.cursor', 'rules', 'codegraph.md');
      const firstContent = fs.readFileSync(rulesPath, 'utf-8');

      // Second install (update)
      writeCursorRules();

      const secondContent = fs.readFileSync(rulesPath, 'utf-8');

      // Should overwrite with latest template
      expect(secondContent).toContain('## CodeGraph');
      expect(secondContent.length).toBeGreaterThan(0);
    });
  });

  describe('Detection Scenarios', () => {
    it('should detect no IDEs when starting fresh', () => {
      // Verify clean slate - no IDEs detected
      expect(hasClaudeMcpConfig('local')).toBe(false);
      expect(hasClaudeMcpConfig('global')).toBe(false);
      expect(hasCursorMcpConfig()).toBe(false);

      // Verify no config directories exist
      expect(fs.existsSync(path.join(process.cwd(), '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(process.cwd(), '.cursor'))).toBe(false);
      expect(fs.existsSync(path.join(helper['tempDir'], '.claude'))).toBe(false);
    });

    it('should detect Claude Code after installation', () => {
      const location: InstallLocation = 'local';

      // Initially not detected
      expect(hasClaudeMcpConfig(location)).toBe(false);

      // Install
      writeMcpConfig(location);

      // Now detected
      expect(hasClaudeMcpConfig(location)).toBe(true);
    });

    it('should detect Cursor after installation', () => {
      // Initially not detected
      expect(hasCursorMcpConfig()).toBe(false);

      // Install
      writeCursorMcpConfig();

      // Now detected
      expect(hasCursorMcpConfig()).toBe(true);
    });

    it('should detect both IDEs independently', () => {
      const location: InstallLocation = 'local';

      // Install Claude Code first
      writeMcpConfig(location);
      expect(hasClaudeMcpConfig(location)).toBe(true);
      expect(hasCursorMcpConfig()).toBe(false);

      // Install Cursor second
      writeCursorMcpConfig();
      expect(hasClaudeMcpConfig(location)).toBe(true);
      expect(hasCursorMcpConfig()).toBe(true);
    });
  });

  describe('Permissions and Hooks', () => {
    it('should add permissions to Claude Code settings', () => {
      const location: InstallLocation = 'local';

      writePermissions(location);

      const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      expect(settings.permissions).toBeDefined();
      expect(settings.permissions.allow).toBeInstanceOf(Array);
      expect(settings.permissions.allow).toContain('mcp__codegraph__codegraph_search');
      expect(settings.permissions.allow).toContain('mcp__codegraph__codegraph_context');
    });

    it('should add hooks to Claude Code settings', () => {
      const location: InstallLocation = 'local';

      writeHooks(location);

      const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();

      const hooksJson = JSON.stringify(settings.hooks);
      expect(hooksJson).toContain('codegraph mark-dirty');
      expect(hooksJson).toContain('codegraph sync-if-dirty');
    });
  });
});
