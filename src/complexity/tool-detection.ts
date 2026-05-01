/**
 * Detect which optional complexity tools are available on the system.
 *
 * The native AST-based analyzer is always available (it uses tree-sitter
 * grammars that ship with codegraph). The only externally-detected tool now
 * is madge, used for circular-dependency / fan-in / fan-out metrics that the
 * AST can't produce on its own.
 */

import { execFile } from 'child_process';
import { ToolAvailability } from './types';

const PROBE_TIMEOUT_MS = 8_000;

function probe(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err) => {
      resolve(!err);
    });
    child.on('error', () => resolve(false));
  });
}

export async function detectAvailableTools(projectRoot: string): Promise<ToolAvailability> {
  const madge = await probe('npx', ['--no-install', 'madge', '--version'], projectRoot);
  return { madge };
}
