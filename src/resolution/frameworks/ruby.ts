/**
 * Ruby Framework Resolver
 *
 * Handles Ruby on Rails patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const railsResolver: FrameworkResolver = {
  name: 'rails',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for Gemfile with rails
    const gemfile = context.readFile('Gemfile');
    if (gemfile && gemfile.includes("'rails'")) {
      return true;
    }

    // Check for config/application.rb (Rails signature)
    if (context.fileExists('config/application.rb')) {
      return true;
    }

    // Check for typical Rails directory structure
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb')
    );
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Model references (ActiveRecord)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = await resolveModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Controller references
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

    // Pattern 3: Helper references
    if (ref.referenceName.endsWith('Helper')) {
      const result = await resolveHelper(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Service/Job references
    if (ref.referenceName.endsWith('Service') || ref.referenceName.endsWith('Job')) {
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

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract route definitions from config/routes.rb
    if (filePath.includes('routes.rb')) {
      // get/post/put/patch/delete 'path'
      const routePatterns = [
        /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/g,
        /resources?\s+:(\w+)/g,
        /root\s+['"]([^'"]+)['"]/g,
        /root\s+to:\s*['"]([^'"]+)['"]/g,
      ];

      for (const pattern of routePatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const line = content.slice(0, match.index).split('\n').length;

          if (pattern.source.includes('resources')) {
            const [, resourceName] = match;
            nodes.push({
              id: `route:${filePath}:resource:${resourceName}:${line}`,
              kind: 'route',
              name: `resource:${resourceName}`,
              qualifiedName: `${filePath}::resource:${resourceName}`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'ruby',
              updatedAt: now,
            });
          } else if (pattern.source.includes('root')) {
            const [, target] = match;
            nodes.push({
              id: `route:${filePath}:root:${line}`,
              kind: 'route',
              name: `/ -> ${target}`,
              qualifiedName: `${filePath}::root`,
              filePath,
              startLine: line,
              endLine: line,
              startColumn: 0,
              endColumn: match[0].length,
              language: 'ruby',
              updatedAt: now,
            });
          } else {
            const [, method, path] = match;
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
              language: 'ruby',
              updatedAt: now,
            });
          }
        }
      }
    }

    // Extract controller actions
    if (filePath.includes('controllers/') && filePath.endsWith('.rb')) {
      const actionPattern = /def\s+(\w+)/g;
      let match;
      while ((match = actionPattern.exec(content)) !== null) {
        const [, actionName] = match;
        const line = content.slice(0, match.index).split('\n').length;

        // Skip private methods and common Rails callbacks
        const privateMethods = ['initialize', 'set_', 'before_', 'after_'];
        if (!privateMethods.some((p) => actionName!.startsWith(p))) {
          nodes.push({
            id: `action:${filePath}:${actionName}:${line}`,
            kind: 'method',
            name: actionName!,
            qualifiedName: `${filePath}::${actionName}`,
            filePath,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: match[0].length,
            language: 'ruby',
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

// Helper functions

async function resolveModel(name: string, context: ResolutionContext): Promise<string | null> {
  // Convert CamelCase to snake_case for file lookup
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/models/${snakeName}.rb`,
    `app/models/concerns/${snakeName}.rb`,
  ];

  for (const modelPath of possiblePaths) {
    if (context.fileExists(modelPath)) {
      const nodes = await context.getNodesInFile(modelPath);
      const modelNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  // Search all model files
  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.includes('app/models/') && file.endsWith('.rb')) {
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

async function resolveController(name: string, context: ResolutionContext): Promise<string | null> {
  // Convert CamelCase to snake_case
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/controllers/${snakeName}.rb`,
    `app/controllers/api/${snakeName}.rb`,
    `app/controllers/api/v1/${snakeName}.rb`,
  ];

  for (const controllerPath of possiblePaths) {
    if (context.fileExists(controllerPath)) {
      const nodes = await context.getNodesInFile(controllerPath);
      const controllerNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (controllerNode) {
        return controllerNode.id;
      }
    }
  }

  // Search all controller files
  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.includes('controllers/') && file.endsWith('.rb')) {
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

async function resolveHelper(name: string, context: ResolutionContext): Promise<string | null> {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const helperPath = `app/helpers/${snakeName}.rb`;

  if (context.fileExists(helperPath)) {
    const nodes = await context.getNodesInFile(helperPath);
    const helperNode = nodes.find(
      (n) => n.kind === 'module' && n.name === name
    );
    if (helperNode) {
      return helperNode.id;
    }
  }

  return null;
}

async function resolveService(name: string, context: ResolutionContext): Promise<string | null> {
  const snakeName = name.replace(/([A-Z])/g, '_$1').toLowerCase().slice(1);
  const possiblePaths = [
    `app/services/${snakeName}.rb`,
    `app/jobs/${snakeName}.rb`,
    `app/workers/${snakeName}.rb`,
  ];

  for (const servicePath of possiblePaths) {
    if (context.fileExists(servicePath)) {
      const nodes = await context.getNodesInFile(servicePath);
      const serviceNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  return null;
}
