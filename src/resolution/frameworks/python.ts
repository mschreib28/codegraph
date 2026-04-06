/**
 * Python Framework Resolver
 *
 * Handles Django, Flask, and FastAPI patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const djangoResolver: FrameworkResolver = {
  name: 'django',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for Django in requirements.txt or setup.py
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.includes('django')) {
      return true;
    }

    const setup = context.readFile('setup.py');
    if (setup && setup.includes('django')) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('django')) {
      return true;
    }

    // Check for manage.py (Django signature)
    return context.fileExists('manage.py');
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Model references
    if (ref.referenceName.endsWith('Model') || /^[A-Z][a-z]+$/.test(ref.referenceName)) {
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

    // Pattern 2: View references
    if (ref.referenceName.endsWith('View') || ref.referenceName.endsWith('ViewSet')) {
      const result = await resolveView(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Form references
    if (ref.referenceName.endsWith('Form')) {
      const result = await resolveForm(ref.referenceName, context);
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

    // Extract URL patterns
    // path('route/', view, name='name')
    const urlPatterns = [
      /path\s*\(\s*['"]([^'"]+)['"],\s*(\w+)/g,
      /url\s*\(\s*r?['"]([^'"]+)['"],\s*(\w+)/g,
    ];

    for (const pattern of urlPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, urlPath] = match;
        const line = content.slice(0, match.index).split('\n').length;

        nodes.push({
          id: `route:${filePath}:${urlPath}:${line}`,
          kind: 'route',
          name: urlPath!,
          qualifiedName: `${filePath}::route:${urlPath}`,
          filePath,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'python',
          updatedAt: now,
        });
      }
    }

    return nodes;
  },
};

export const flaskResolver: FrameworkResolver = {
  name: 'flask',

  async detect(context: ResolutionContext): Promise<boolean> {
    const requirements = context.readFile('requirements.txt');
    if (requirements && (requirements.includes('flask') || requirements.includes('Flask'))) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('flask')) {
      return true;
    }

    // Check for Flask app pattern in common files
    const appFiles = ['app.py', 'application.py', 'main.py', '__init__.py'];
    for (const file of appFiles) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) {
        return true;
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Blueprint references
    if (ref.referenceName.endsWith('_bp') || ref.referenceName.endsWith('_blueprint')) {
      const result = await resolveBlueprint(ref.referenceName, context);
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

    // Extract Flask route decorators
    // @app.route('/path') or @blueprint.route('/path')
    const routePattern = /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, _appOrBp, routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${routePath}:${line}`,
        kind: 'route',
        name: `${routePath}`,
        qualifiedName: `${filePath}::route:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',

  async detect(context: ResolutionContext): Promise<boolean> {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.includes('fastapi')) {
      return true;
    }

    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.includes('fastapi')) {
      return true;
    }

    // Check for FastAPI app pattern
    const appFiles = ['app.py', 'main.py', 'api.py'];
    for (const file of appFiles) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI()')) {
        return true;
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Router references
    if (ref.referenceName.endsWith('_router') || ref.referenceName === 'router') {
      const result = await resolveRouter(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Dependency references
    if (ref.referenceName.startsWith('get_') || ref.referenceName.startsWith('Depends')) {
      const result = await resolveDependency(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Extract FastAPI route decorators
    // @app.get('/path') or @router.post('/path')
    const routePattern = /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, _appOrRouter, method, routePath] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${routePath}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} ${routePath}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${routePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'python',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions

async function resolveModel(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['models', 'app/models', 'src/models'];

  for (const dir of modelDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) && file.endsWith('.py')) {
        const nodes = await context.getNodesInFile(file);
        const modelNode = nodes.find(
          (n) => n.kind === 'class' && n.name === name
        );
        if (modelNode) {
          return modelNode.id;
        }
      }
    }
  }

  return null;
}

async function resolveView(name: string, context: ResolutionContext): Promise<string | null> {
  const viewDirs = ['views', 'app/views', 'src/views', 'api/views'];

  for (const dir of viewDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) && file.endsWith('.py')) {
        const nodes = await context.getNodesInFile(file);
        const viewNode = nodes.find(
          (n) => (n.kind === 'class' || n.kind === 'function') && n.name === name
        );
        if (viewNode) {
          return viewNode.id;
        }
      }
    }
  }

  return null;
}

async function resolveForm(name: string, context: ResolutionContext): Promise<string | null> {
  const formDirs = ['forms', 'app/forms', 'src/forms'];

  for (const dir of formDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.startsWith(dir) && file.endsWith('.py')) {
        const nodes = await context.getNodesInFile(file);
        const formNode = nodes.find(
          (n) => n.kind === 'class' && n.name === name
        );
        if (formNode) {
          return formNode.id;
        }
      }
    }
  }

  return null;
}

async function resolveBlueprint(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.py')) {
      const nodes = await context.getNodesInFile(file);
      const bpNode = nodes.find(
        (n) => n.kind === 'variable' && n.name === name
      );
      if (bpNode) {
        return bpNode.id;
      }
    }
  }

  return null;
}

async function resolveRouter(name: string, context: ResolutionContext): Promise<string | null> {
  const routerDirs = ['routers', 'api', 'routes', 'endpoints'];

  for (const dir of routerDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if ((file.startsWith(dir) || file.includes('/routers/')) && file.endsWith('.py')) {
        const nodes = await context.getNodesInFile(file);
        const routerNode = nodes.find(
          (n) => n.kind === 'variable' && n.name === name
        );
        if (routerNode) {
          return routerNode.id;
        }
      }
    }
  }

  return null;
}

async function resolveDependency(name: string, context: ResolutionContext): Promise<string | null> {
  const depDirs = ['dependencies', 'deps', 'core'];

  for (const dir of depDirs) {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if ((file.startsWith(dir) || file.includes('/dependencies/')) && file.endsWith('.py')) {
        const nodes = await context.getNodesInFile(file);
        const depNode = nodes.find(
          (n) => n.kind === 'function' && n.name === name
        );
        if (depNode) {
          return depNode.id;
        }
      }
    }
  }

  return null;
}
