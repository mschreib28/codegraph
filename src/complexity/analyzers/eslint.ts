/**
 * ESLint cyclomatic-complexity analyzer for JS/TS/JSX/TSX.
 *
 * Runs ESLint with the built-in `complexity` rule set to threshold 1, which
 * reports a message for every function/method along with its computed
 * cyclomatic complexity. We parse those messages back into per-symbol records.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import { Language } from '../../types';
import { AnalyzerContext, ComplexityRecord, LanguageAnalyzer } from '../types';

const SUPPORTED_LANGUAGES: Language[] = ['typescript', 'javascript', 'tsx', 'jsx'];
const TIMEOUT_MS = 120_000;
const BATCH_SIZE = 100; // avoid huge argv

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line?: number;
  column?: number;
}
interface EslintResult {
  filePath: string;
  messages: EslintMessage[];
}

// Message looks like: "Function 'foo' has a complexity of 7."
// Or: "Arrow function has a complexity of 4."
const COMPLEXITY_RE = /complexity of (\d+)/i;
const NAME_RE = /(?:Function|Method|Arrow function|Async function|Generator function)\s+'([^']+)'/i;

function runEslint(projectRoot: string, files: string[]): Promise<EslintResult[]> {
  return new Promise((resolve) => {
    const args = [
      '--no-install',
      'eslint',
      '--no-eslintrc',
      '--no-config-lookup',
      '--no-error-on-unmatched-pattern',
      '--rule', '{"complexity":["warn",1]}',
      '--format', 'json',
      ...files,
    ];
    execFile('npx', args, {
      cwd: projectRoot,
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }, (_err, stdout) => {
      // ESLint exits non-zero when warnings/errors are present — that's expected.
      // We only care about parsing the JSON it printed.
      if (!stdout) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as EslintResult[];
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

export function createEslintAnalyzer(available: boolean): LanguageAnalyzer {
  return {
    languages: SUPPORTED_LANGUAGES,
    tool: 'eslint',
    available,
    async analyze(ctx: AnalyzerContext): Promise<ComplexityRecord[]> {
      if (!available || ctx.files.length === 0) return [];

      const records: ComplexityRecord[] = [];
      for (let i = 0; i < ctx.files.length; i += BATCH_SIZE) {
        const batch = ctx.files.slice(i, i + BATCH_SIZE);
        const results = await runEslint(ctx.projectRoot, batch);
        for (const result of results) {
          const rel = path.relative(ctx.projectRoot, result.filePath) || result.filePath;
          const language = inferLanguage(rel);
          for (const msg of result.messages) {
            if (msg.ruleId !== 'complexity') continue;
            const m = COMPLEXITY_RE.exec(msg.message);
            if (!m || !m[1]) continue;
            const value = Number.parseInt(m[1], 10);
            if (!Number.isFinite(value)) continue;
            const nameMatch = NAME_RE.exec(msg.message);
            records.push({
              filePath: rel,
              symbolName: nameMatch?.[1] ?? null,
              startLine: msg.line ?? null,
              language,
              tool: 'eslint',
              metric: 'cyclomatic',
              value,
              computedAt: ctx.computedAt,
            });
          }
        }
      }
      return records;
    },
  };
}

function inferLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx') return 'jsx';
  return 'javascript';
}
