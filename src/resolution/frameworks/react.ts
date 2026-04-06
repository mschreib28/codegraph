/**
 * React Framework Resolver
 *
 * Handles React and Next.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const reactResolver: FrameworkResolver = {
  name: 'react',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for React in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .jsx/.tsx files
    const allFiles = await context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Component references (PascalCase)
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const result = await resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = await resolveHook(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = await resolveContext(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract component definitions
    // function Component() or const Component = () =>
    const componentPatterns = [
      // Function components
      /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
      // Arrow function components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
      // forwardRef components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
      // memo components
      /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [fullMatch, name] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Check if it returns JSX (rough heuristic)
        const afterMatch = content.slice(match.index + fullMatch.length, match.index + fullMatch.length + 500);
        const hasJSX = afterMatch.includes('<') && (afterMatch.includes('/>') || afterMatch.includes('</'));

        if (hasJSX) {
          nodes.push({
            id: `component:${filePath}:${name}:${line}`,
            kind: 'component',
            name: name!,
            qualifiedName: `${filePath}::${name}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language: filePath.endsWith('.tsx') ? 'tsx' : 'jsx',
            isExported: fullMatch.includes('export'),
            updatedAt: now,
          });
        }
      }
    }

    // Extract custom hooks
    const hookPattern = /(?:export\s+)?(?:function|const|let)\s+(use[A-Z][a-zA-Z0-9]*)\s*[=(]/g;
    let hookMatch;
    while ((hookMatch = hookPattern.exec(content)) !== null) {
      const [fullMatch, name] = hookMatch;
      const line = content.slice(0, hookMatch.index).split('\n').length;

      nodes.push({
        id: `hook:${filePath}:${name}:${line}`,
        kind: 'function',
        name: name!,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: fullMatch.length,
        language: filePath.endsWith('.ts') || filePath.endsWith('.tsx') ? 'typescript' : 'javascript',
        isExported: fullMatch.includes('export'),
        updatedAt: now,
      });
    }

    // Extract Next.js pages/routes (pages directory convention)
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      // Default export in pages becomes a route
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const line = content.indexOf('export default');
          const lineNum = content.slice(0, line).split('\n').length;

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: lineNum,
            endLine: lineNum,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.tsx') ? 'tsx' : filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Check if name is a built-in type
 */
function isBuiltInType(name: string): boolean {
  const builtIns = [
    'Array', 'Boolean', 'Date', 'Error', 'Function', 'JSON', 'Math', 'Number',
    'Object', 'Promise', 'RegExp', 'String', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'React', 'Component', 'Fragment', 'Suspense', 'StrictMode',
  ];
  return builtIns.includes(name);
}

/**
 * Resolve a component reference
 */
async function resolveComponent(
  name: string,
  fromFile: string,
  context: ResolutionContext
): Promise<string | null> {
  // Look for component in common locations
  const componentDirs = [
    'components',
    'src/components',
    'app/components',
    'pages',
    'src/pages',
    'views',
    'src/views',
  ];

  // First, check same directory
  const fromDir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const allFilesForSameDir = await context.getAllFiles();
  const sameDir = allFilesForSameDir.filter((f) => f.startsWith(fromDir));
  for (const file of sameDir) {
    if (file.toLowerCase().includes(name.toLowerCase())) {
      const nodes = await context.getNodesInFile(file);
      const component = nodes.find(
        (n) => (n.kind === 'component' || n.kind === 'function' || n.kind === 'class') && n.name === name
      );
      if (component) {
        return component.id;
      }
    }
  }

  // Then check component directories
  for (const dir of componentDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) && file.toLowerCase().includes(name.toLowerCase())) {
        const nodes = await context.getNodesInFile(file);
        const component = nodes.find(
          (n) => (n.kind === 'component' || n.kind === 'function' || n.kind === 'class') && n.name === name
        );
        if (component) {
          return component.id;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve a custom hook reference
 */
async function resolveHook(name: string, context: ResolutionContext): Promise<string | null> {
  const hookDirs = ['hooks', 'src/hooks', 'lib/hooks', 'utils/hooks'];

  for (const dir of hookDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) || file.includes('/hooks/')) {
        const nodes = await context.getNodesInFile(file);
        const hook = nodes.find((n) => n.kind === 'function' && n.name === name);
        if (hook) {
          return hook.id;
        }
      }
    }
  }

  // Also check all files for the hook
  const allNodes = await context.getNodesByName(name);
  const hookNode = allNodes.find((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hookNode) {
    return hookNode.id;
  }

  return null;
}

/**
 * Resolve a context reference
 */
async function resolveContext(name: string, context: ResolutionContext): Promise<string | null> {
  const contextDirs = ['context', 'contexts', 'src/context', 'src/contexts', 'providers', 'src/providers'];

  for (const dir of contextDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) || file.includes('/context/') || file.includes('/contexts/')) {
        const nodes = await context.getNodesInFile(file);
        const contextNode = nodes.find((n) => n.name === name || n.name === name.replace(/Context$|Provider$/, ''));
        if (contextNode) {
          return contextNode.id;
        }
      }
    }
  }

  return null;
}

/**
 * Convert file path to Next.js route
 */
function filePathToRoute(filePath: string): string | null {
  // pages/index.tsx -> /
  // pages/about.tsx -> /about
  // pages/blog/[slug].tsx -> /blog/:slug
  // app/page.tsx -> /
  // app/about/page.tsx -> /about

  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (filePath.includes('app/')) {
    // App router - only page.tsx files are routes
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
