/**
 * Rust Framework Resolver
 *
 * Handles Actix-web, Rocket, Axum, and common Rust patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const rustResolver: FrameworkResolver = {
  name: 'rust',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for Cargo.toml (Rust project signature)
    return context.fileExists('Cargo.toml');
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('_handler') || ref.referenceName.startsWith('handle_')) {
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

    // Pattern 2: Service/Repository trait implementations
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Repository')) {
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

    // Pattern 3: Struct references (PascalCase)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = await resolveStruct(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Module references
    if (/^[a-z_]+$/.test(ref.referenceName)) {
      const result = await resolveModule(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.6,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract Actix-web routes
    // #[get("/path")], #[post("/path")], etc.
    const actixRoutePattern = /#\[(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = actixRoutePattern.exec(content)) !== null) {
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
        language: 'rust',
        updatedAt: now,
      });
    }

    // Extract Rocket routes
    // #[get("/path")], #[post("/path", ...)]
    const rocketRoutePattern = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']/g;

    while ((match = rocketRoutePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;

      // Avoid duplicates from actix pattern
      const routeId = `route:${filePath}:${method!.toUpperCase()}:${path}:${line}`;
      if (!nodes.some((n) => n.id === routeId)) {
        nodes.push({
          id: routeId,
          kind: 'route',
          name: `${method!.toUpperCase()} ${path}`,
          qualifiedName: `${filePath}::${method!.toUpperCase()}:${path}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'rust',
          updatedAt: now,
        });
      }
    }

    // Extract Axum routes (method chaining style)
    // .route("/path", get(handler))
    const axumRoutePattern = /\.route\s*\(\s*["']([^"']+)["']\s*,\s*(get|post|put|patch|delete)/g;

    while ((match = axumRoutePattern.exec(content)) !== null) {
      const [, path, method] = match;
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
        language: 'rust',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions

async function resolveHandler(name: string, context: ResolutionContext): Promise<string | null> {
  const handlerDirs = ['handlers', 'handler', 'api', 'routes', 'controllers'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.rs') && handlerDirs.some((d) => file.includes(`/${d}/`) || file.includes(`/${d}.rs`))) {
      const nodes = await context.getNodesInFile(file);
      const handlerNode = nodes.find(
        (n) => n.kind === 'function' && n.name === name
      );
      if (handlerNode) {
        return handlerNode.id;
      }
    }
  }

  // Search all Rust files
  for (const file of allFiles) {
    if (file.endsWith('.rs')) {
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
  const serviceDirs = ['services', 'service', 'repository', 'domain'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.rs') && serviceDirs.some((d) => file.includes(`/${d}/`) || file.includes(`/${d}.rs`))) {
      const nodes = await context.getNodesInFile(file);
      const serviceNode = nodes.find(
        (n) => (n.kind === 'struct' || n.kind === 'trait') && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}

async function resolveStruct(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['models', 'model', 'entities', 'entity', 'domain', 'types'];

  const allFiles = await context.getAllFiles();

  // Check model directories first
  for (const file of allFiles) {
    if (file.endsWith('.rs') && modelDirs.some((d) => file.includes(`/${d}/`) || file.includes(`/${d}.rs`))) {
      const nodes = await context.getNodesInFile(file);
      const structNode = nodes.find(
        (n) => n.kind === 'struct' && n.name === name
      );
      if (structNode) {
        return structNode.id;
      }
    }
  }

  // Search all Rust files
  for (const file of allFiles) {
    if (file.endsWith('.rs')) {
      const nodes = await context.getNodesInFile(file);
      const structNode = nodes.find(
        (n) => n.kind === 'struct' && n.name === name
      );
      if (structNode) {
        return structNode.id;
      }
    }
  }

  return null;
}

async function resolveModule(name: string, context: ResolutionContext): Promise<string | null> {
  // Rust modules can be either mod.rs in a directory or name.rs
  const possiblePaths = [
    `src/${name}.rs`,
    `src/${name}/mod.rs`,
  ];

  for (const modPath of possiblePaths) {
    if (context.fileExists(modPath)) {
      const nodes = await context.getNodesInFile(modPath);
      const modNode = nodes.find((n) => n.kind === 'module');
      if (modNode) {
        return modNode.id;
      }
      // If no explicit module node, return the first node in the file
      if (nodes.length > 0) {
        return nodes[0]!.id;
      }
    }
  }

  return null;
}
