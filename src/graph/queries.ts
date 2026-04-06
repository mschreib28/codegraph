/**
 * Graph Query Functions
 *
 * Higher-level query functions built on top of traversal algorithms.
 */

import { Node, Edge, Context, Subgraph, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

/**
 * Graph query manager for complex queries
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * Get full context for a node
   *
   * Returns the focal node along with its ancestors, children,
   * and both incoming and outgoing references.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  async getContext(nodeId: string): Promise<Context> {
    const focal = await this.queries.getNodeById(nodeId);

    if (!focal) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // Get ancestors (containment hierarchy)
    const ancestors = await this.traverser.getAncestors(nodeId);

    // Get children
    const children = await this.traverser.getChildren(nodeId);

    // Get incoming references (things that reference this node)
    const incomingEdges = await this.queries.getIncomingEdges(nodeId);
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      // Skip containment edges (already in ancestors)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = await this.queries.getNodeById(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // Get outgoing references (things this node references)
    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId);
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of outgoingEdges) {
      // Skip containment edges (already in children)
      if (edge.kind === 'contains') {
        continue;
      }
      const node = await this.queries.getNodeById(edge.target);
      if (node) {
        outgoingRefs.push({ node, edge });
      }
    }

    // Get type information (type_of, returns edges)
    const types: Node[] = [];
    const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
    for (const kind of typeEdgeKinds) {
      const typeEdges = await this.queries.getOutgoingEdges(nodeId, [kind]);
      for (const edge of typeEdges) {
        const typeNode = await this.queries.getNodeById(edge.target);
        if (typeNode && !types.some((t) => t.id === typeNode.id)) {
          types.push(typeNode);
        }
      }
    }

    // Get relevant imports
    const imports: Node[] = [];
    const fileNode = ancestors.find((a) => a.kind === 'file');
    if (fileNode) {
      const importEdges = await this.queries.getOutgoingEdges(fileNode.id, ['imports']);
      for (const edge of importEdges) {
        const importNode = await this.queries.getNodeById(edge.target);
        if (importNode) {
          imports.push(importNode);
        }
      }
    }

    return {
      focal,
      ancestors,
      children,
      incomingRefs,
      outgoingRefs,
      types,
      imports,
    };
  }

  /**
   * Get dependencies of a file
   *
   * Returns all files that this file imports from.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  async getFileDependencies(filePath: string): Promise<string[]> {
    const nodes = await this.queries.getNodesByFile(filePath);
    const fileNode = nodes.find((n) => n.kind === 'file');

    if (!fileNode) {
      return [];
    }

    const dependencies = new Set<string>();
    const importEdges = await this.queries.getOutgoingEdges(fileNode.id, ['imports']);

    for (const edge of importEdges) {
      const targetNode = await this.queries.getNodeById(edge.target);
      if (targetNode && targetNode.filePath !== filePath) {
        dependencies.add(targetNode.filePath);
      }
    }

    return Array.from(dependencies);
  }

  /**
   * Get dependents of a file
   *
   * Returns all files that import from this file.
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  async getFileDependents(filePath: string): Promise<string[]> {
    const nodes = await this.queries.getNodesByFile(filePath);
    const dependents = new Set<string>();

    // Check file-level incoming import edges (file:X imports file:Y)
    const fileNode = nodes.find((n) => n.kind === 'file');
    if (fileNode) {
      const incomingFileEdges = await this.queries.getIncomingEdges(fileNode.id, ['imports']);
      for (const edge of incomingFileEdges) {
        const sourceNode = await this.queries.getNodeById(edge.source);
        if (sourceNode && sourceNode.filePath !== filePath) {
          dependents.add(sourceNode.filePath);
        }
      }
    }

    // Also check node-level imports of exported symbols
    for (const node of nodes) {
      if (node.isExported) {
        const incomingEdges = await this.queries.getIncomingEdges(node.id, ['imports']);
        for (const edge of incomingEdges) {
          const sourceNode = await this.queries.getNodeById(edge.source);
          if (sourceNode && sourceNode.filePath !== filePath) {
            dependents.add(sourceNode.filePath);
          }
        }
      }
    }

    return Array.from(dependents);
  }

  /**
   * Get all symbols exported by a file
   *
   * @param filePath - Path to the file
   * @returns Array of exported nodes
   */
  async getExportedSymbols(filePath: string): Promise<Node[]> {
    const nodes = await this.queries.getNodesByFile(filePath);
    return nodes.filter((n) => n.isExported);
  }

  /**
   * Find symbols by qualified name pattern
   *
   * @param pattern - Pattern to match (supports * wildcard)
   * @returns Array of matching nodes
   */
  async findByQualifiedName(pattern: string): Promise<Node[]> {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    // This is inefficient for large graphs - would need FTS index on qualified_name
    // For now, use kind-based filtering if possible
    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    for (const kind of kinds) {
      const nodes = await this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (regex.test(node.qualifiedName)) {
          allNodes.push(node);
        }
      }
    }

    return allNodes;
  }

  /**
   * Get the module/package structure
   *
   * Returns a tree structure of files organized by directory.
   *
   * @returns Map of directory paths to contained files
   */
  async getModuleStructure(): Promise<Map<string, string[]>> {
    const files = await this.queries.getAllFiles();
    const structure = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';

      if (!structure.has(dir)) {
        structure.set(dir, []);
      }
      structure.get(dir)!.push(file.path);
    }

    return structure;
  }

  /**
   * Find circular dependencies in the graph
   *
   * @returns Array of cycles, each cycle is an array of node IDs
   */
  async findCircularDependencies(): Promise<string[][]> {
    const files = await this.queries.getAllFiles();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = async (filePath: string, path: string[]): Promise<void> => {
      if (recursionStack.has(filePath)) {
        // Found a cycle
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return;
      }

      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      recursionStack.add(filePath);

      const dependencies = await this.getFileDependencies(filePath);
      for (const dep of dependencies) {
        await dfs(dep, [...path, filePath]);
      }

      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) {
        await dfs(file.path, []);
      }
    }

    return cycles;
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  async getNodeMetrics(nodeId: string): Promise<{
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  }> {
    const incomingEdges = await this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId);

    const callEdges = outgoingEdges.filter((e) => e.kind === 'calls');
    const callerEdges = incomingEdges.filter((e) => e.kind === 'calls');
    const containsEdges = outgoingEdges.filter((e) => e.kind === 'contains');

    const ancestors = await this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * Find dead code (nodes with no incoming references)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  async findDeadCode(kinds?: Node['kind'][]): Promise<Node[]> {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];

    for (const kind of targetKinds) {
      const nodes = await this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        // Skip exported symbols (they may be used externally)
        if (node.isExported) {
          continue;
        }

        const incomingEdges = await this.queries.getIncomingEdges(node.id);

        // Filter out containment edges
        const references = incomingEdges.filter((e) => e.kind !== 'contains');

        if (references.length === 0) {
          deadCode.push(node);
        }
      }
    }

    return deadCode;
  }

  /**
   * Get subgraph containing nodes matching a filter
   *
   * @param filter - Filter function to select nodes
   * @param includeEdges - Whether to include edges between matching nodes
   * @returns Subgraph containing matching nodes
   */
  async getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Promise<Subgraph> {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Get all nodes of common kinds
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];

    for (const kind of kinds) {
      const kindNodes = await this.queries.getNodesByKind(kind);
      for (const node of kindNodes) {
        if (filter(node)) {
          nodes.set(node.id, node);
        }
      }
    }

    // Include edges between matching nodes
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = await this.queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.target)) {
            edges.push(edge);
          }
        }
      }
    }

    return {
      nodes,
      edges,
      roots: [],
    };
  }

  /**
   * Access the underlying traverser for direct traversal operations
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
