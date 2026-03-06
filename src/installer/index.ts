/**
 * CodeGraph Interactive Installer
 *
 * Provides a beautiful interactive CLI experience for setting up CodeGraph
 * with supported IDEs (Claude Code, Cursor, etc.).
 */

import { execSync } from 'child_process';
import { showBanner, showNextSteps, success, error, info, chalk } from './banner';
import { promptIDE, promptInstallLocation, promptAutoAllow, InstallLocation, IDE } from './prompts';
import {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  writeHooks,
  hasClaudeMcpConfig,
  hasPermissions,
  hasHooks,
  writeCursorMcpConfig,
  writeCursorRules,
  hasCursorMcpConfig,
} from './config-writer';

/**
 * Format a number with commas
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * Installer options for non-interactive mode
 */
export interface InstallerOptions {
  ide?: string; // Comma-separated list or "all"
  location?: 'global' | 'local';
}

/**
 * Parse IDE string from CLI argument
 */
function parseIDEArg(ideArg: string): IDE {
  if (ideArg.toLowerCase() === 'all') {
    return ['claude', 'cursor'];
  }
  const ides = ideArg.split(',').map(s => s.trim().toLowerCase());
  const valid: IDE = [];
  for (const ide of ides) {
    if (ide === 'claude' || ide === 'cursor') {
      valid.push(ide);
    }
  }
  if (valid.length === 0) {
    throw new Error(`Invalid IDE(s): ${ideArg}. Use "claude", "cursor", or "all"`);
  }
  return valid;
}

/**
 * Run the interactive installer
 */
export async function runInstaller(options?: InstallerOptions): Promise<void> {
  // Show the banner
  showBanner();

  try {
    // Step 1: Install codegraph globally.
    // Always run npm install -g — we can't use `command -v codegraph` to check
    // because npx puts a temporary binary in PATH that vanishes when npx exits.
    console.log(chalk.dim('  Installing codegraph globally...'));
    try {
      execSync('npm install -g @colbymchenry/codegraph', { stdio: 'pipe' });
      success('Installed codegraph command globally');
    } catch {
      info('Could not install globally (permission denied)');
      info('Try: sudo npm install -g @colbymchenry/codegraph');
    }
    console.log();

    // Step 2: Ask which IDE(s) to configure (or use provided)
    const ide = options?.ide ? parseIDEArg(options.ide) : await promptIDE();
    console.log();

    // Step 3: Ask for installation location (or use provided)
    const location = options?.location || await promptInstallLocation(ide);
    console.log();

    // Step 4: Configure selected IDEs
    for (const ideName of ide) {
      if (ideName === 'claude') {
        await installForClaude(location);
      } else if (ideName === 'cursor') {
        await installForCursor();
      }
    }

    // Step 6: For local install, initialize the project
    if (location === 'local') {
      await initializeLocalProject();
    }

    // Show next steps
    showNextSteps(location, ide);
  } catch (err) {
    console.log();
    if (err instanceof Error && err.message.includes('readline was closed')) {
      // User cancelled with Ctrl+C
      console.log(chalk.dim('  Installation cancelled.'));
    } else {
      error(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

/**
 * Initialize CodeGraph in the current project (for local installs)
 */
async function initializeLocalProject(): Promise<void> {
  const projectPath = process.cwd();

  // Lazy-load CodeGraph (requires native modules)
  let CodeGraph: typeof import('../index').default;
  try {
    CodeGraph = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Could not load native modules: ${msg}`);
    info('Skipping project initialization. You can run "codegraph init -i" later.');
    info('If this persists, try a Node.js LTS version (20 or 22).');
    return;
  }

  // Check if already initialized
  if (CodeGraph.isInitialized(projectPath)) {
    info('CodeGraph already initialized in this project');
    return;
  }

  console.log();
  console.log(chalk.dim('  Initializing CodeGraph in current project...'));

  // Initialize CodeGraph
  const cg = await CodeGraph.init(projectPath);
  success('Created .codegraph/ directory');

  // Index the project
  const result = await cg.indexAll({
    onProgress: (progress) => {
      // Simple progress indicator
      const phaseNames: Record<string, string> = {
        scanning: 'Scanning files',
        parsing: 'Parsing code',
        storing: 'Storing data',
        resolving: 'Resolving refs',
      };
      const phaseName = phaseNames[progress.phase] || progress.phase;
      const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;
      process.stdout.write(`\r  ${chalk.dim(phaseName)}... ${percent}%   `);
    },
  });

  // Clear progress line
  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  if (result.success) {
    success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    success(`Indexed ${formatNumber(result.filesIndexed)} files with ${result.errors.length} warnings`);
  }

  cg.close();
}

/**
 * Install and configure for Claude Code
 */
async function installForClaude(location: InstallLocation): Promise<void> {
  // Write MCP configuration (always uses npx for reliability)
  const alreadyHasMcp = hasClaudeMcpConfig(location);
  writeMcpConfig(location);

  if (alreadyHasMcp) {
    success(`Updated MCP server in ${location === 'global' ? '~/.claude.json' : './.claude.json'}`);
  } else {
    success(`Added MCP server to ${location === 'global' ? '~/.claude.json' : './.claude.json'}`);
  }

  // Ask about auto-allow permissions
  const autoAllow = await promptAutoAllow();
  console.log();

  if (autoAllow) {
    const alreadyHasPerms = hasPermissions(location);
    writePermissions(location);

    if (alreadyHasPerms) {
      success(`Updated permissions in ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
    } else {
      success(`Added permissions to ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
    }
  }

  // Write auto-sync hooks
  const alreadyHasHooks = hasHooks(location);
  writeHooks(location);

  if (alreadyHasHooks) {
    success(`Updated auto-sync hooks in ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
  } else {
    success(`Added auto-sync hooks to ${location === 'global' ? '~/.claude/settings.json' : './.claude/settings.json'}`);
  }

  // Write CLAUDE.md instructions
  const claudeMdResult = writeClaudeMd(location);
  const claudeMdPath = location === 'global' ? '~/.claude/CLAUDE.md' : './.claude/CLAUDE.md';

  if (claudeMdResult.created) {
    success(`Created ${claudeMdPath} with CodeGraph instructions`);
  } else if (claudeMdResult.updated) {
    success(`Updated CodeGraph section in ${claudeMdPath}`);
  } else {
    success(`Added CodeGraph instructions to ${claudeMdPath}`);
  }
}

/**
 * Install and configure for Cursor
 * Note: Cursor only supports local configuration
 */
async function installForCursor(): Promise<void> {
  // Write MCP configuration
  const alreadyHasMcp = hasCursorMcpConfig();
  writeCursorMcpConfig();

  if (alreadyHasMcp) {
    success('Updated MCP server in ./.cursor/mcp.json');
  } else {
    success('Added MCP server to ./.cursor/mcp.json');
  }

  // Write Cursor rules file
  const cursorRulesResult = writeCursorRules();

  if (cursorRulesResult.created) {
    success('Created .cursor/rules/codegraph.md with instructions');
  } else if (cursorRulesResult.updated) {
    success('Updated .cursor/rules/codegraph.md');
  }

  console.log();
  info('Note: MCP tools in Cursor are only available in Agent mode, not Composer');
}

// Export for use in CLI
export { InstallLocation, IDE };
