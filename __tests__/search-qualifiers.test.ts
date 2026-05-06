/**
 * Integration tests for search qualifiers that go through the SQL
 * layer: sig:, callers-of:, callees-of:.
 *
 * Mirrors the synthetic-fixture style of resolution.test.ts — small
 * temp project, real CodeGraph index, query the result. These cover
 * the SQL paths (signatureLike pre-filter, nodesCallingAny / nodesCalledByAny)
 * that the parser-only tests can't exercise.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('Search qualifiers — DB-level integration', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-qualifiers-'));
  });

  afterEach(() => {
    if (cg) {
      cg.destroy();
      cg = null;
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  async function indexFixture(files: Record<string, string>): Promise<CodeGraph> {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, 'src', name), content);
    }
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 't', version: '0.0.0' })
    );
    const inst = await CodeGraph.init(tempDir, { config: { llm: { endpoint: '' } }, index: true });
    cg = inst;
    return inst;
  }

  it('sig: filters results by signature substring', async () => {
    const cg = await indexFixture({
      'a.ts': `
export async function fetchUser(): Promise<User> { return {} as User; }
export function getCount(): number { return 0; }
type User = { id: string };
`,
    });
    const results = cg.searchNodes('sig:Promise<User>');
    const names = results.map((r) => r.node.name);
    expect(names).toContain('fetchUser');
    expect(names).not.toContain('getCount');
  });

  it('multi-sig: composes as OR (matches path:/name: semantics)', async () => {
    const cg = await indexFixture({
      'a.ts': `
export function fa(): Promise<string> { return Promise.resolve('a'); }
export function fb(): number[] { return []; }
export function fc(): string { return ''; }
`,
    });
    const r = cg.searchNodes('sig:Promise sig:number[] kind:function');
    const names = r.map((x) => x.node.name);
    expect(names).toContain('fa');   // matches sig:Promise
    expect(names).toContain('fb');   // matches sig:number[]
    expect(names).not.toContain('fc');
  });

  it('callers-of: returns nodes that call NAME', async () => {
    const cg = await indexFixture({
      'a.ts': `
export function target() { return 1; }
export function helper() { return target(); }
export function other() { return 2; }
`,
    });
    const r = cg.searchNodes('callers-of:target');
    const names = r.map((x) => x.node.name);
    expect(names).toContain('helper');
    expect(names).not.toContain('other');
  });

  it('callees-of: returns nodes called BY NAME', async () => {
    const cg = await indexFixture({
      'a.ts': `
export function leaf1() { return 1; }
export function leaf2() { return 2; }
export function unrelated() { return 99; }
export function root() { return leaf1() + leaf2(); }
`,
    });
    const r = cg.searchNodes('callees-of:root');
    const names = r.map((x) => x.node.name);
    expect(names).toContain('leaf1');
    expect(names).toContain('leaf2');
    expect(names).not.toContain('unrelated');
  });

  it('callers-of: composes with kind: filter', async () => {
    const cg = await indexFixture({
      'a.ts': `
export function target() { return 1; }
export class Caller { method() { return target(); } }
export function helper() { return target(); }
`,
    });
    const r = cg.searchNodes('callers-of:target kind:method');
    const names = r.map((x) => x.node.name);
    expect(names).toContain('method');
    expect(names).not.toContain('helper');
  });
});
