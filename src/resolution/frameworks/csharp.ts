/**
 * C# Framework Resolver
 *
 * Handles ASP.NET Core, ASP.NET MVC, and common C# patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for .csproj files with ASP.NET references
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('Microsoft.AspNetCore') ||
          content.includes('Microsoft.NET.Sdk.Web') ||
          content.includes('System.Web.Mvc')
        )) {
          return true;
        }
      }
    }

    // Check for Program.cs with WebApplication
    const programCs = context.readFile('Program.cs');
    if (programCs && (
      programCs.includes('WebApplication') ||
      programCs.includes('CreateHostBuilder') ||
      programCs.includes('UseStartup')
    )) {
      return true;
    }

    // Check for Startup.cs (ASP.NET Core signature)
    if (context.fileExists('Startup.cs')) {
      return true;
    }

    // Check for Controllers directory
    return allFiles.some((f) => f.includes('/Controllers/') && f.endsWith('Controller.cs'));
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = await resolveController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service') || ref.referenceName.startsWith('I') && ref.referenceName.length > 1) {
      const result = await resolveService(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Repository references
    if (ref.referenceName.endsWith('Repository')) {
      const result = await resolveRepository(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references
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

    // Pattern 5: ViewModel references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Dto')) {
      const result = await resolveViewModel(ref.referenceName, context);
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

    // Extract route attributes
    // [HttpGet("path")], [HttpPost("path")], [Route("path")]
    const routePatterns = [
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\(\s*["']([^"']+)["']\s*\)\]/g,
      /\[(Http(Get|Post|Put|Patch|Delete))\s*\]/g,
      /\[Route\s*\(\s*["']([^"']+)["']\s*\)\]/g,
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const line = content.slice(0, match.index).split('\n').length;

        if (pattern.source.includes('Http')) {
          if (match[3]) {
            // HttpGet("path") style
            const [, , method, path] = match;
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
              language: 'csharp',
              updatedAt: now,
            });
          } else if (match[2]) {
            // HttpGet style without path
            const [, , method] = match;
            nodes.push({
              id: `route:${filePath}:${method!.toUpperCase()}:${line}`,
              kind: 'route',
              name: `${method!.toUpperCase()}`,
              qualifiedName: `${filePath}::${method!.toUpperCase()}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'csharp',
              updatedAt: now,
            });
          }
        } else {
          // [Route("path")] style
          const [, path] = match;
          nodes.push({
            id: `route:${filePath}:ROUTE:${path}:${line}`,
            kind: 'route',
            name: `ROUTE ${path}`,
            qualifiedName: `${filePath}::ROUTE:${path}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'csharp',
            updatedAt: now,
          });
        }
      }
    }

    // Extract minimal API routes (ASP.NET Core 6+)
    // app.MapGet("/path", ...), app.MapPost("/path", ...)
    const minimalApiPattern = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = minimalApiPattern.exec(content)) !== null) {
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
        language: 'csharp',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions

async function resolveController(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.cs') && file.includes('/Controllers/')) {
      const nodes = await context.getNodesInFile(file);
      const controllerNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (controllerNode) {
        return controllerNode.id;
      }
    }
  }

  return null;
}

async function resolveService(name: string, context: ResolutionContext): Promise<string | null> {
  const serviceDirs = ['Services', 'Service', 'Application'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.cs') && serviceDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const serviceNode = nodes.find(
        (n) => (n.kind === 'class' || n.kind === 'interface') && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  // Search all C# files for interfaces (often services are injected via interface)
  for (const file of allFiles) {
    if (file.endsWith('.cs')) {
      const nodes = await context.getNodesInFile(file);
      const serviceNode = nodes.find(
        (n) => (n.kind === 'class' || n.kind === 'interface') && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}

async function resolveRepository(name: string, context: ResolutionContext): Promise<string | null> {
  const repoDirs = ['Repositories', 'Repository', 'Data', 'Infrastructure'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.cs') && repoDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const repoNode = nodes.find(
        (n) => (n.kind === 'class' || n.kind === 'interface') && n.name === name
      );
      if (repoNode) {
        return repoNode.id;
      }
    }
  }

  return null;
}

async function resolveModel(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['Models', 'Model', 'Entities', 'Entity', 'Domain'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.cs') && modelDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const modelNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  return null;
}

async function resolveViewModel(name: string, context: ResolutionContext): Promise<string | null> {
  const viewModelDirs = ['ViewModels', 'ViewModel', 'DTOs', 'Dto'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.cs') && viewModelDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const vmNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (vmNode) {
        return vmNode.id;
      }
    }
  }

  return null;
}
