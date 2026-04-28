/**
 * codegraph_status output: project-root surfacing + multi-project list.
 *
 * Regression guard for the friction point where an agent calling MCP
 * tools couldn't tell which project the server's default points at,
 * so couldn't tell whether to start passing `projectPath` on later
 * calls. status's first line must always answer that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-status-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function makeProject(dir: string, file: string): Promise<CodeGraph> {
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', file),
    `export function f(): number { return 1; }\n`
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: path.basename(dir), version: '0.0.0' })
  );
  const cg = await CodeGraph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  return cg;
}

describe('codegraph_status — project-root surfacing', () => {
  let dirs: string[] = [];
  let cgs: CodeGraph[] = [];
  let handler: ToolHandler | null = null;

  beforeEach(() => {
    dirs = [];
    cgs = [];
    handler = null;
  });

  afterEach(() => {
    // Close any cached projects the handler opened — otherwise we
    // leak SQLite handles + leave WAL files in tmp.
    handler?.closeAll();
    for (const cg of cgs) {
      try {
        cg.close();
      } catch {
        /* idempotent — already closed by closeAll() */
      }
    }
    for (const d of dirs) cleanup(d);
  });

  it('shows the project root labelled as "default" when the server has a default and projectPath is omitted', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const cg = await makeProject(dir, 'a.ts');
    cgs.push(cg);

    handler = new ToolHandler(cg);
    const result = await handler.execute('codegraph_status', {});
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(new RegExp(`Project root.*\`${path.resolve(dir)}\``));
    expect(text).toMatch(/default/);
    expect(text).toMatch(/server CWD at startup/);
  });

  it('shows the project root labelled as "from `projectPath`" when projectPath is supplied', async () => {
    const defaultDir = tempDir();
    const otherDir = tempDir();
    dirs.push(defaultDir, otherDir);
    const defaultCg = await makeProject(defaultDir, 'a.ts');
    cgs.push(defaultCg);
    // Initialize the second project's .codegraph/ but don't keep our
    // own handle — the ToolHandler will open it via projectPath and
    // own its lifecycle through projectCache.
    const tmpCg = await makeProject(otherDir, 'b.ts');
    tmpCg.close();

    handler = new ToolHandler(defaultCg);
    const result = await handler.execute('codegraph_status', { projectPath: otherDir });
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(new RegExp(`Project root.*\`${path.resolve(otherDir)}\``));
    expect(text).toMatch(/from `projectPath` argument/);
  });

  it('lists other projects the server has open under "Other projects this server has open"', async () => {
    const defaultDir = tempDir();
    const otherDir = tempDir();
    dirs.push(defaultDir, otherDir);
    const defaultCg = await makeProject(defaultDir, 'a.ts');
    cgs.push(defaultCg);
    const tmpCg = await makeProject(otherDir, 'b.ts');
    tmpCg.close();

    handler = new ToolHandler(defaultCg);
    // Prime the cache with the second project.
    await handler.execute('codegraph_status', { projectPath: otherDir });
    // Now query the default — it should mention the other project.
    const result = await handler.execute('codegraph_status', {});
    const text = result.content[0]?.text ?? '';

    expect(text).toMatch(/### Other projects this server has open/);
    expect(text).toContain(path.resolve(otherDir));
  });

  it('throws an actionable error suggesting `projectPath` when no default and projectPath omitted', async () => {
    handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_status', {});
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No default codegraph project/);
    expect(text).toMatch(/projectPath/);
    expect(text).toMatch(/codegraph init/);
  });

  it('throws an actionable error pointing at the supplied path when projectPath has no .codegraph/', async () => {
    const dir = tempDir();
    dirs.push(dir);
    // Note: we deliberately did NOT call makeProject — there's no .codegraph/.
    handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_status', { projectPath: dir });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No \.codegraph\/ found/);
    expect(text).toContain(dir);
  });
});
