/**
 * User prompts for the CodeGraph installer
 * Uses built-in readline to avoid ESM issues with inquirer
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { chalk } from './banner';

export type InstallLocation = 'global' | 'local';
export type IDEName = 'claude' | 'cursor';
export type IDE = IDEName[];  // Array of selected IDEs

/**
 * Create a readline interface for prompts
 */
function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Detect which IDEs are installed by checking for their config directories
 */
function detectInstalledIDEs(): IDEName[] {
  const detected: IDEName[] = [];

  // Check for Claude Code config (global or local)
  const hasGlobalClaude = fs.existsSync(path.join(os.homedir(), '.claude'));
  const hasLocalClaude = fs.existsSync(path.join(process.cwd(), '.claude'));
  if (hasGlobalClaude || hasLocalClaude) {
    detected.push('claude');
  }

  // Check for Cursor config (local only)
  const hasCursor = fs.existsSync(path.join(process.cwd(), '.cursor'));
  if (hasCursor) {
    detected.push('cursor');
  }

  return detected;
}

/**
 * Prompt the user with a question and return their answer
 */
function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt for IDE selection with checkbox-style input
 * Users can select multiple IDEs by entering comma-separated numbers (e.g., "1,2")
 * Auto-detects installed IDEs and uses them as defaults
 *
 * For non-interactive shells:
 * - If IDEs are detected, uses detected IDEs
 * - Otherwise defaults to Claude Code only
 */
export async function promptIDE(): Promise<IDE> {
  // Detect installed IDEs
  const detected = detectInstalledIDEs();

  // Non-interactive: use detected IDEs or default to Claude Code
  if (!isInteractive()) {
    if (detected.length > 0) {
      return detected;
    }
    return ['claude'];
  }

  const rl = createInterface();

  // Build default selection string
  const defaultSelections: string[] = [];
  if (detected.includes('claude')) defaultSelections.push('1');
  if (detected.includes('cursor')) defaultSelections.push('2');
  const defaultStr = defaultSelections.length > 0 ? defaultSelections.join(',') : '1';

  console.log(chalk.bold('  Which IDE(s) would you like to configure?'));
  console.log(chalk.dim('  (Enter comma-separated numbers, e.g., "1,2" for both)'));
  console.log();

  // Show Claude Code with detection indicator
  if (detected.includes('claude')) {
    console.log('  1) Claude Code ' + chalk.green('✓ Detected'));
  } else {
    console.log('  1) Claude Code');
  }

  // Show Cursor with detection indicator
  if (detected.includes('cursor')) {
    console.log('  2) Cursor ' + chalk.green('✓ Detected'));
  } else {
    console.log('  2) Cursor');
  }
  console.log();

  const answer = await prompt(rl, `  Selection [${defaultStr}]: `);
  rl.close();

  // Parse comma-separated selections
  const selections = (answer === '' ? defaultStr : answer)
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');

  const ides: IDEName[] = [];

  for (const selection of selections) {
    if (selection === '1') {
      if (!ides.includes('claude')) ides.push('claude');
    } else if (selection === '2') {
      if (!ides.includes('cursor')) ides.push('cursor');
    }
  }

  // If no valid selections, default to Claude Code
  if (ides.length === 0) {
    ides.push('claude');
  }

  return ides;
}

/**
 * Check if running in an interactive terminal
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Prompt for installation location (global or local)
 * Defaults to 'local' for non-interactive shells
 */
export async function promptInstallLocation(ides: IDE): Promise<InstallLocation> {
  const hasClaudeCode = ides.includes('claude');
  const hasCursor = ides.includes('cursor');
  const cursorOnly = hasCursor && !hasClaudeCode;

  // Cursor only supports local installation
  if (cursorOnly) {
    return 'local';
  }

  // Non-interactive: default to local
  if (!isInteractive()) {
    return 'local';
  }

  const rl = createInterface();

  console.log(chalk.bold('  Where would you like to install?'));
  console.log();

  console.log('  1) Local (./.claude) - this project only');
  console.log('  2) Global (~/.claude) - available in all projects');
  if (hasCursor) {
    console.log(chalk.dim('     Note: Cursor will be configured locally regardless'));
  }
  console.log();

  const answer = await prompt(rl, '  Selection [1]: ');
  rl.close();

  // Default to '1' (local) if empty, parse the answer
  const choice = answer === '' ? '1' : answer;

  if (choice === '2') {
    return 'global';
  }
  return 'local';
}

/**
 * Prompt for auto-allow permissions
 */
export async function promptAutoAllow(): Promise<boolean> {
  const rl = createInterface();

  console.log();
  console.log(chalk.bold('  Auto-allow CodeGraph commands?') + chalk.dim(' (Skips permission prompts)'));
  console.log();
  console.log('  1) Yes - auto-approve all codegraph_* tools');
  console.log('  2) No - ask for permission each time');
  console.log();

  const answer = await prompt(rl, '  Choice [1]: ');
  rl.close();

  // Default to '1' if empty
  const choice = answer === '' ? '1' : answer;

  return choice !== '2';
}

/**
 * Prompt for confirmation (yes/no)
 */
export async function promptConfirm(message: string, defaultYes: boolean = true): Promise<boolean> {
  const rl = createInterface();

  const defaultStr = defaultYes ? 'Y/n' : 'y/N';
  const answer = await prompt(rl, `  ${message} [${defaultStr}]: `);
  rl.close();

  if (answer === '') {
    return defaultYes;
  }

  return answer.toLowerCase().startsWith('y');
}
