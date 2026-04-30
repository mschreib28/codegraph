/**
 * Detect which complexity tools are available on the system.
 *
 * For npm-distributed tools (eslint, madge) we try `npx --no-install --version`
 * which succeeds only if the binary exists in node_modules or is global.
 * For radon we check the executable on PATH.
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
  const [eslint, madge, radon] = await Promise.all([
    probe('npx', ['--no-install', 'eslint', '--version'], projectRoot),
    probe('npx', ['--no-install', 'madge', '--version'], projectRoot),
    probe('radon', ['--version'], projectRoot),
  ]);
  return { eslint, madge, radon };
}
