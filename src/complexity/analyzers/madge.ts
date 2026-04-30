/**
 * madge analyzer: derives JS/TS dependency metrics (fan-in, fan-out, circular).
 *
 * `madge --json` emits a map of file → list of files it depends on. From this
 * we count outgoing deps per file (fan-out) and reverse it to get fan-in. We
 * also flag files that participate in any circular dependency cycle.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { Language } from '../../types';
import { AnalyzerContext, ComplexityRecord, LanguageAnalyzer } from '../types';

const SUPPORTED_LANGUAGES: Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];
const TIMEOUT_MS = 180_000;

interface MadgeJson { [file: string]: string[] }

function runMadge(projectRoot: string, paths: string[], json: 'deps' | 'circular'): Promise<unknown> {
  return new Promise((resolve) => {
    const baseArgs = [
      '--no-install',
      'madge',
      '--json',
      '--ts-config', 'tsconfig.json',
      '--extensions', 'ts,tsx,js,jsx,mjs,cjs',
    ];
    const args = json === 'circular'
      ? [...baseArgs, '--circular', ...paths]
      : [...baseArgs, ...paths];
    execFile('npx', args, {
      cwd: projectRoot,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024,
    }, (_err, stdout) => {
      if (!stdout) { resolve(json === 'circular' ? [] : {}); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(json === 'circular' ? [] : {}); }
    });
  });
}

export function createMadgeAnalyzer(available: boolean): LanguageAnalyzer {
  return {
    languages: SUPPORTED_LANGUAGES,
    tool: 'madge',
    available,
    async analyze(ctx: AnalyzerContext): Promise<ComplexityRecord[]> {
      if (!available || ctx.files.length === 0) return [];

      // madge needs entry roots, not a long file list. Pass distinct top-level dirs.
      const roots = collectRoots(ctx.files);
      const deps = (await runMadge(ctx.projectRoot, roots, 'deps')) as MadgeJson;
      const circular = (await runMadge(ctx.projectRoot, roots, 'circular')) as string[][];

      const fanOut = new Map<string, number>();
      const fanIn = new Map<string, number>();
      for (const [file, targets] of Object.entries(deps)) {
        fanOut.set(file, targets.length);
        for (const tgt of targets) {
          fanIn.set(tgt, (fanIn.get(tgt) ?? 0) + 1);
          if (!fanOut.has(tgt)) fanOut.set(tgt, 0);
        }
      }

      const circularSet = new Set<string>();
      for (const cycle of circular) {
        for (const f of cycle) circularSet.add(f);
      }

      const fileSet = new Set(ctx.files);
      const records: ComplexityRecord[] = [];
      const seen = new Set<string>();
      for (const file of new Set([...fanOut.keys(), ...fanIn.keys()])) {
        // madge uses paths relative to projectRoot already.
        if (!fileSet.has(file)) continue;
        if (seen.has(file)) continue;
        seen.add(file);

        const language = inferLanguage(file);
        const out = fanOut.get(file) ?? 0;
        const incoming = fanIn.get(file) ?? 0;
        records.push({
          filePath: file, language, tool: 'madge', metric: 'fan_out',
          value: out, computedAt: ctx.computedAt,
        });
        records.push({
          filePath: file, language, tool: 'madge', metric: 'fan_in',
          value: incoming, computedAt: ctx.computedAt,
        });
        if (circularSet.has(file)) {
          records.push({
            filePath: file, language, tool: 'madge', metric: 'is_circular',
            value: 1, computedAt: ctx.computedAt,
          });
        }
      }
      return records;
    },
  };
}

function collectRoots(files: string[]): string[] {
  const tops = new Set<string>();
  for (const f of files) {
    const top = f.split(path.sep)[0];
    if (top) tops.add(top);
  }
  return Array.from(tops);
}

function inferLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  return 'javascript';
}
