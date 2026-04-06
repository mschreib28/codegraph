/**
 * Java Framework Resolver
 *
 * Handles Spring Boot and general Java patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const springResolver: FrameworkResolver = {
  name: 'spring',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for pom.xml with Spring
    const pomXml = context.readFile('pom.xml');
    if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
      return true;
    }

    // Check for build.gradle with Spring
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))) {
      return true;
    }

    // Check for Spring annotations in Java files
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.java')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Service references (dependency injection)
    if (ref.referenceName.endsWith('Service')) {
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

    // Pattern 2: Repository references
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

    // Pattern 3: Controller references
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

    // Pattern 4: Entity/Model references
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = await resolveEntity(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 5: Component references
    if (ref.referenceName.endsWith('Component') || ref.referenceName.endsWith('Config')) {
      const result = await resolveComponent(ref.referenceName, context);
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

    // Extract REST endpoints
    // @GetMapping("/path"), @PostMapping("/path"), etc.
    const mappingPatterns = [
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g,
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:path\s*=\s*)?["']([^"']+)["']/g,
    ];

    for (const pattern of mappingPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const [, mappingType, path] = match;
        const line = content.slice(0, match.index).split('\n').length;

        const method = mappingType === 'Request' ? 'ANY' : mappingType!.toUpperCase();

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
          language: 'java',
          updatedAt: now,
        });
      }
    }

    // Extract class-level @RequestMapping for base path
    const baseMappingMatch = content.match(/@RequestMapping\s*\(\s*["']([^"']+)["']\s*\)/);
    if (baseMappingMatch) {
      const [, basePath] = baseMappingMatch;
      const line = content.slice(0, baseMappingMatch.index).split('\n').length;

      nodes.push({
        id: `route:${filePath}:BASE:${basePath}:${line}`,
        kind: 'route',
        name: `BASE ${basePath}`,
        qualifiedName: `${filePath}::BASE:${basePath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: baseMappingMatch[0].length,
        language: 'java',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions

async function resolveService(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.java') && (file.includes('/service/') || file.includes('/services/'))) {
      const nodes = await context.getNodesInFile(file);
      const serviceNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (serviceNode) {
        return serviceNode.id;
      }
    }
  }

  // Also check interface definitions
  for (const file of allFiles) {
    if (file.endsWith('.java')) {
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
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.java') && (file.includes('/repository/') || file.includes('/repositories/'))) {
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

async function resolveController(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.java') && (file.includes('/controller/') || file.includes('/controllers/'))) {
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

async function resolveEntity(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  // Check entity/model directories first
  for (const file of allFiles) {
    if (file.endsWith('.java') && (
      file.includes('/entity/') ||
      file.includes('/entities/') ||
      file.includes('/model/') ||
      file.includes('/models/') ||
      file.includes('/domain/')
    )) {
      const nodes = await context.getNodesInFile(file);
      const entityNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (entityNode) {
        return entityNode.id;
      }
    }
  }

  return null;
}

async function resolveComponent(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.java') && (
      file.includes('/component/') ||
      file.includes('/components/') ||
      file.includes('/config/')
    )) {
      const nodes = await context.getNodesInFile(file);
      const componentNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (componentNode) {
        return componentNode.id;
      }
    }
  }

  return null;
}
