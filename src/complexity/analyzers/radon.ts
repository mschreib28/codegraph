/**
 * radon analyzer for Python: cyclomatic complexity (cc) and maintainability (mi).
 *
 * `radon cc -j <files>` returns: { "<file>": [{ "type": "function", "name": "...",
 *    "lineno": N, "complexity": N, ... }, ...], ... }
 * `radon mi -j <files>` returns: { "<file>": { "mi": N, "rank": "A" }, ... }
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { Language } from '../../types';
import { AnalyzerContext, ComplexityRecord, LanguageAnalyzer } from '../types';

const SUPPORTED_LANGUAGES: Language[] = ['python'];
const TIMEOUT_MS = 120_000;
const BATCH_SIZE = 200;

interface RadonCcEntry {
  type: string;
  name: string;
  lineno: number;
  complexity: number;
  classname?: string;
}
interface RadonMiEntry {
  mi: number;
  rank?: string;
}

function runRadon(projectRoot: string, command: 'cc' | 'mi', files: string[]): Promise<unknown> {
  return new Promise((resolve) => {
    execFile('radon', [command, '-j', ...files], {
      cwd: projectRoot,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }, (_err, stdout) => {
      if (!stdout) { resolve({}); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve({}); }
    });
  });
}

export function createRadonAnalyzer(available: boolean): LanguageAnalyzer {
  return {
    languages: SUPPORTED_LANGUAGES,
    tool: 'radon',
    available,
    async analyze(ctx: AnalyzerContext): Promise<ComplexityRecord[]> {
      if (!available || ctx.files.length === 0) return [];

      const records: ComplexityRecord[] = [];
      for (let i = 0; i < ctx.files.length; i += BATCH_SIZE) {
        const batch = ctx.files.slice(i, i + BATCH_SIZE);
        const [ccRaw, miRaw] = await Promise.all([
          runRadon(ctx.projectRoot, 'cc', batch),
          runRadon(ctx.projectRoot, 'mi', batch),
        ]);

        const cc = ccRaw as Record<string, RadonCcEntry[] | { error: string }>;
        for (const [file, entries] of Object.entries(cc)) {
          if (!Array.isArray(entries)) continue;
          const rel = toRelative(ctx.projectRoot, file);
          for (const entry of entries) {
            if (typeof entry.complexity !== 'number') continue;
            const name = entry.classname ? `${entry.classname}.${entry.name}` : entry.name;
            records.push({
              filePath: rel,
              symbolName: name,
              startLine: entry.lineno ?? null,
              language: 'python',
              tool: 'radon',
              metric: 'cyclomatic',
              value: entry.complexity,
              computedAt: ctx.computedAt,
            });
          }
        }

        const mi = miRaw as Record<string, RadonMiEntry | { error: string }>;
        for (const [file, entry] of Object.entries(mi)) {
          if (!entry || typeof (entry as RadonMiEntry).mi !== 'number') continue;
          const rel = toRelative(ctx.projectRoot, file);
          records.push({
            filePath: rel,
            language: 'python',
            tool: 'radon',
            metric: 'maintainability',
            value: (entry as RadonMiEntry).mi,
            computedAt: ctx.computedAt,
          });
        }
      }
      return records;
    },
  };
}

function toRelative(projectRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    const rel = path.relative(projectRoot, filePath);
    return rel === '' ? path.basename(filePath) : rel;
  }
  return filePath;
}
