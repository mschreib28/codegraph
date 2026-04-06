/**
 * Go Framework Resolver
 *
 * Handles Gin, Echo, Fiber, Chi, and standard library patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const goResolver: FrameworkResolver = {
  name: 'go',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for go.mod file (Go modules)
    const goMod = context.readFile('go.mod');
    if (goMod) {
      return true;
    }

    // Check for .go files
    const allFiles = await context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.go'));
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = await resolveHandler(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service/Repository references
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository') || ref.referenceName.endsWith('Store')) {
      const result = await resolveService(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware') || ref.referenceName.startsWith('Auth') || ref.referenceName.startsWith('Log')) {
      const result = await resolveMiddleware(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references (typically PascalCase structs)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = await resolveModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract Gin routes
    // r.GET("/path", handler), router.POST("/path", handler), etc.
    const ginRoutePattern = /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = ginRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method}:${path}:${line}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualifiedName: `${filePath}::${method}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      });
    }

    // Extract Echo routes
    // e.GET("/path", handler)
    const echoRoutePattern = /e\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*["']([^"']+)["']/g;

    while ((match = echoRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method}:${path}:${line}`,
        kind: 'route',
        name: `${method} ${path}`,
        qualifiedName: `${filePath}::${method}:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      });
    }

    // Extract Chi routes
    // r.Get("/path", handler), r.Post("/path", handler)
    const chiRoutePattern = /r\.\s*(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g;

    while ((match = chiRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

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
        language: 'go',
        updatedAt: now,
      });
    }

    // Extract standard library http.HandleFunc
    const httpHandlePattern = /http\.HandleFunc\s*\(\s*["']([^"']+)["']/g;

    while ((match = httpHandlePattern.exec(content)) !== null) {
      const [, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:ANY:${path}:${line}`,
        kind: 'route',
        name: `ANY ${path}`,
        qualifiedName: `${filePath}::ANY:${path}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'go',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions

async function resolveHandler(name: string, context: ResolutionContext): Promise<string | null> {
  const handlerDirs = ['handler', 'handlers', 'api', 'routes', 'controller', 'controllers'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.go') && handlerDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const handlerNode = nodes.find(
        (n) => n.kind === 'function' && n.name === name
      );
      if (handlerNode) {
        return handlerNode.id;
      }
    }
  }

  // Search all go files
  for (const file of allFiles) {
    if (file.endsWith('.go')) {
      const nodes = await context.getNodesInFile(file);
      const handlerNode = nodes.find(
        (n) => n.kind === 'function' && n.name === name
      );
      if (handlerNode) {
        return handlerNode.id;
      }
    }
  }

  return null;
}

async function resolveService(name: string, context: ResolutionContext): Promise<string | null> {
  const serviceDirs = ['service', 'services', 'repository', 'store', 'pkg'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.go') && serviceDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const serviceNode = nodes.find(
        (n) => (n.kind === 'struct' || n.kind === 'interface') && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}

async function resolveMiddleware(name: string, context: ResolutionContext): Promise<string | null> {
  const middlewareDirs = ['middleware', 'middlewares'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.go') && middlewareDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const mwNode = nodes.find(
        (n) => n.kind === 'function' && n.name === name
      );
      if (mwNode) {
        return mwNode.id;
      }
    }
  }

  return null;
}

async function resolveModel(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['model', 'models', 'entity', 'entities', 'domain', 'pkg'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.go') && modelDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const modelNode = nodes.find(
        (n) => n.kind === 'struct' && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  return null;
}
