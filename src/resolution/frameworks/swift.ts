/**
 * Swift Framework Resolver
 *
 * Handles SwiftUI, UIKit, and Vapor (server-side Swift) patterns.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for SwiftUI imports in Swift files
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) {
          return true;
        }
      }
    }

    // Check for Xcode project with SwiftUI
    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) {
        return true;
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: View references (SwiftUI views are PascalCase ending in View)
    if (ref.referenceName.endsWith('View') && /^[A-Z]/.test(ref.referenceName)) {
      const result = await resolveView(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: ViewModel/ObservableObject references
    if (ref.referenceName.endsWith('ViewModel') || ref.referenceName.endsWith('Store') || ref.referenceName.endsWith('Manager')) {
      const result = await resolveViewModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Model references
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

    // Extract SwiftUI View structs
    // struct ContentView: View { ... }
    const viewPattern = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g;

    let match;
    while ((match = viewPattern.exec(content)) !== null) {
      const [, viewName] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `view:${filePath}:${viewName}:${line}`,
        kind: 'component',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // Extract @main App entry point
    const appPattern = /@main\s+struct\s+(\w+)\s*:\s*App/g;

    while ((match = appPattern.exec(content)) !== null) {
      const [, appName] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `app:${filePath}:${appName}:${line}`,
        kind: 'class',
        name: appName!,
        qualifiedName: `${filePath}::${appName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',

  async detect(context: ResolutionContext): Promise<boolean> {
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('import UIKit') ||
          content.includes('UIViewController') ||
          content.includes('UIView')
        )) {
          return true;
        }
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: ViewController references
    if (ref.referenceName.endsWith('ViewController')) {
      const result = await resolveViewController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: UIView subclass references
    if (ref.referenceName.endsWith('View') && !ref.referenceName.endsWith('ViewController')) {
      const result = await resolveUIView(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Cell references
    if (ref.referenceName.endsWith('Cell')) {
      const result = await resolveCell(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Delegate/DataSource references
    if (ref.referenceName.endsWith('Delegate') || ref.referenceName.endsWith('DataSource')) {
      const result = await resolveProtocol(ref.referenceName, context);
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

    // Extract UIViewController subclasses
    const vcPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g;

    let match;
    while ((match = vcPattern.exec(content)) !== null) {
      const [, vcName] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `viewcontroller:${filePath}:${vcName}:${line}`,
        kind: 'class',
        name: vcName!,
        qualifiedName: `${filePath}::${vcName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    // Extract UIView subclasses
    const viewPattern = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIView[^C]/g;

    while ((match = viewPattern.exec(content)) !== null) {
      const [, viewName] = match;
      const line = content.slice(0, match.index).split('\n').length;

      nodes.push({
        id: `uiview:${filePath}:${viewName}:${line}`,
        kind: 'class',
        name: viewName!,
        qualifiedName: `${filePath}::${viewName}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',

  async detect(context: ResolutionContext): Promise<boolean> {
    // Check for Package.swift with Vapor dependency
    const packageSwift = context.readFile('Package.swift');
    if (packageSwift && packageSwift.includes('vapor')) {
      return true;
    }

    // Check for Vapor imports
    const allFiles = await context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) {
          return true;
        }
      }
    }

    return false;
  },

  async resolve(ref: UnresolvedRef, context: ResolutionContext): Promise<ResolvedRef | null> {
    // Pattern 1: Controller references
    if (ref.referenceName.endsWith('Controller')) {
      const result = await resolveVaporController(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Model references (Fluent)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = await resolveFluentModel(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (ref.referenceName.endsWith('Middleware')) {
      const result = await resolveVaporMiddleware(ref.referenceName, context);
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

    // Extract Vapor routes
    // app.get("path") { ... }, app.post("path") { ... }
    const routePattern = /\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

    let match;
    while ((match = routePattern.exec(content)) !== null) {
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
        language: 'swift',
        updatedAt: now,
      });
    }

    // Extract grouped routes
    // app.grouped("api").get("users") { ... }
    const groupedRoutePattern = /\.grouped\s*\(\s*["']([^"']+)["']\s*\)\s*\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/g;

    while ((match = groupedRoutePattern.exec(content)) !== null) {
      const [, prefix, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      const fullPath = `${prefix}/${path}`;

      nodes.push({
        id: `route:${filePath}:${method!.toUpperCase()}:${fullPath}:${line}`,
        kind: 'route',
        name: `${method!.toUpperCase()} /${fullPath}`,
        qualifiedName: `${filePath}::${method!.toUpperCase()}:${fullPath}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'swift',
        updatedAt: now,
      });
    }

    return nodes;
  },
};

// Helper functions for SwiftUI

async function resolveView(name: string, context: ResolutionContext): Promise<string | null> {
  const viewDirs = ['Views', 'View', 'Screens', 'Components', 'UI'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && viewDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const viewNode = nodes.find(
        (n) => (n.kind === 'struct' || n.kind === 'component') && n.name === name
      );
      if (viewNode) {
        return viewNode.id;
      }
    }
  }

  // Search all Swift files
  for (const file of allFiles) {
    if (file.endsWith('.swift')) {
      const nodes = await context.getNodesInFile(file);
      const viewNode = nodes.find(
        (n) => (n.kind === 'struct' || n.kind === 'component') && n.name === name
      );
      if (viewNode) {
        return viewNode.id;
      }
    }
  }

  return null;
}

async function resolveViewModel(name: string, context: ResolutionContext): Promise<string | null> {
  const vmDirs = ['ViewModels', 'ViewModel', 'Stores', 'Managers', 'Services'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && vmDirs.some((d) => file.includes(`/${d}/`))) {
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

async function resolveModel(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['Models', 'Model', 'Entities', 'Domain'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && modelDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const modelNode = nodes.find(
        (n) => (n.kind === 'struct' || n.kind === 'class') && n.name === name
      );
      if (modelNode) {
        return modelNode.id;
      }
    }
  }

  return null;
}

// Helper functions for UIKit

async function resolveViewController(name: string, context: ResolutionContext): Promise<string | null> {
  const vcDirs = ['ViewControllers', 'ViewController', 'Controllers', 'Screens'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && (vcDirs.some((d) => file.includes(`/${d}/`)) || file.includes(name))) {
      const nodes = await context.getNodesInFile(file);
      const vcNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (vcNode) {
        return vcNode.id;
      }
    }
  }

  return null;
}

async function resolveUIView(name: string, context: ResolutionContext): Promise<string | null> {
  const viewDirs = ['Views', 'View', 'UI', 'Components'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && viewDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const viewNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (viewNode) {
        return viewNode.id;
      }
    }
  }

  return null;
}

async function resolveCell(name: string, context: ResolutionContext): Promise<string | null> {
  const cellDirs = ['Cells', 'Cell', 'Views', 'TableViewCells', 'CollectionViewCells'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && cellDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const cellNode = nodes.find(
        (n) => n.kind === 'class' && n.name === name
      );
      if (cellNode) {
        return cellNode.id;
      }
    }
  }

  return null;
}

async function resolveProtocol(name: string, context: ResolutionContext): Promise<string | null> {
  const allFiles = await context.getAllFiles();

  for (const file of allFiles) {
    if (file.endsWith('.swift')) {
      const nodes = await context.getNodesInFile(file);
      const protocolNode = nodes.find(
        (n) => n.kind === 'protocol' && n.name === name
      );
      if (protocolNode) {
        return protocolNode.id;
      }
    }
  }

  return null;
}

// Helper functions for Vapor

async function resolveVaporController(name: string, context: ResolutionContext): Promise<string | null> {
  const controllerDirs = ['Controllers', 'Controller', 'Routes'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && controllerDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const controllerNode = nodes.find(
        (n) => (n.kind === 'class' || n.kind === 'struct') && n.name === name
      );
      if (controllerNode) {
        return controllerNode.id;
      }
    }
  }

  return null;
}

async function resolveFluentModel(name: string, context: ResolutionContext): Promise<string | null> {
  const modelDirs = ['Models', 'Model', 'Entities', 'Database'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && modelDirs.some((d) => file.includes(`/${d}/`))) {
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

async function resolveVaporMiddleware(name: string, context: ResolutionContext): Promise<string | null> {
  const middlewareDirs = ['Middleware', 'Middlewares'];

  const allFiles = await context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.swift') && middlewareDirs.some((d) => file.includes(`/${d}/`))) {
      const nodes = await context.getNodesInFile(file);
      const mwNode = nodes.find(
        (n) => (n.kind === 'class' || n.kind === 'struct') && n.name === name
      );
      if (mwNode) {
        return mwNode.id;
      }
    }
  }

  return null;
}
