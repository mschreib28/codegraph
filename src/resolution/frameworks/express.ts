/**
 * Express/Node.js Framework Resolver
 *
 * Handles Express and general Node.js patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const expressResolver: FrameworkResolver = {
  name: 'express',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for Express in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for common Express patterns
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file);
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
          return true;
        }
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Middleware references
    if (isMiddlewareName(ref.referenceName)) {
      const result = await resolveMiddleware(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Controller method references
    const controllerMatch = ref.referenceName.match(/^(\w+)Controller\.(\w+)$/);
    if (controllerMatch) {
      const [, controller, method] = controllerMatch;
      const result = await resolveController(controller!, method!, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Service/helper references
    const serviceMatch = ref.referenceName.match(/^(\w+)(Service|Helper|Utils?)\.(\w+)$/);
    if (serviceMatch) {
      const [, name, suffix, method] = serviceMatch;
      const result = await resolveService(name! + suffix!, method!, context);
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

    // Extract route definitions
    // app.get('/path', handler) or router.get('/path', handler)
    const routePatterns = [
      /(app|router)\.(get|post|put|patch|delete|all|use)\(\s*['"]([^'"]+)['"]/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, _obj, method, path] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Skip middleware use() without paths
        if (method === 'use' && !path?.startsWith('/')) {
          continue;
        }

        nodes.push({
          id: `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`,
          kind: 'route',
          name: `${method!.toUpperCase()} ${path}`,
          qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: detectLanguage(filePath),
          updatedAt: now,
        });
      }
    }

    return nodes;
  },
};

/**
 * Check if a name looks like middleware
 */
function isMiddlewareName(name: string): boolean {
  const middlewarePatterns = [
    /^auth$/i,
    /^authenticate$/i,
    /^authorization$/i,
    /^validate/i,
    /^sanitize/i,
    /^rateLimit/i,
    /^cors$/i,
    /^helmet$/i,
    /^logger$/i,
    /^errorHandler$/i,
    /^notFound$/i,
    /Middleware$/i,
  ];

  return middlewarePatterns.some((p) => p.test(name));
}

/**
 * Resolve middleware reference
 */
async function resolveMiddleware(
  name: string,
  context: ResolutionContext
): Promise<string | null> {
  // Look in middleware directories
  const middlewareDirs = ['middleware', 'middlewares', 'src/middleware', 'src/middlewares'];

  for (const dir of middlewareDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) || file.includes('/middleware/')) {
        const nodes = await context.getNodesInFile(file);
        const match = nodes.find(
          (n) =>
            n.name.toLowerCase() === name.toLowerCase() ||
            n.name.toLowerCase() === name.replace(/Middleware$/i, '').toLowerCase()
        );
        if (match) {
          return match.id;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve controller method
 */
async function resolveController(
  controller: string,
  method: string,
  context: ResolutionContext
): Promise<string | null> {
  const controllerDirs = ['controllers', 'src/controllers', 'app/controllers'];

  for (const dir of controllerDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (
        (file.startsWith(dir) || file.includes('/controllers/')) &&
        file.toLowerCase().includes(controller.toLowerCase())
      ) {
        const nodes = await context.getNodesInFile(file);
        const methodNode = nodes.find(
          (n) => (n.kind === 'method' || n.kind === 'function') && n.name === method
        );
        if (methodNode) {
          return methodNode.id;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve service/helper
 */
async function resolveService(
  serviceName: string,
  method: string,
  context: ResolutionContext
): Promise<string | null> {
  const serviceDirs = ['services', 'src/services', 'helpers', 'src/helpers', 'utils', 'src/utils'];

  for (const dir of serviceDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (
        (file.startsWith(dir) || file.includes('/services/') || file.includes('/helpers/') || file.includes('/utils/')) &&
        file.toLowerCase().includes(serviceName.toLowerCase().replace(/(service|helper|utils?)$/i, ''))
      ) {
        const nodes = await context.getNodesInFile(file);
        const methodNode = nodes.find(
          (n) => (n.kind === 'method' || n.kind === 'function') && n.name === method
        );
        if (methodNode) {
          return methodNode.id;
        }
      }
    }
  }

  return null;
}

/**
 * Detect language from file extension
 */
function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript';
  }
  return 'javascript';
}
