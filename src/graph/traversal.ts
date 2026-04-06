/**
 * Graph Traversal Algorithms
 *
 * BFS and DFS traversal for the code knowledge graph.
 */

import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * Default traversal options
 */
const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/**
 * Result of a single traversal step
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/**
 * Graph traverser for BFS and DFS traversal
 */
export class GraphTraverser {
  private queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  /**
   * Traverse the graph using breadth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  async traverseBFS(startId: string, options: TraversalOptions = {}): Promise<Subgraph> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = await this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      // Add edge to result
      if (edge) {
        edges.push(edge);
      }

      // Check depth limit
      if (depth >= opts.maxDepth) {
        continue;
      }

      // Get adjacent edges
      const adjacentEdges = await this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

      for (const adjEdge of adjacentEdges) {
        // Determine next node: for 'both' direction, edges can be either
        // incoming or outgoing, so pick whichever end is not the current node
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;

        if (visited.has(nextNodeId)) {
          continue;
        }

        const nextNode = await this.queries.getNodeById(nextNodeId);
        if (!nextNode) {
          continue;
        }

        // Apply node kind filter
        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        // Add node to result
        nodes.set(nextNode.id, nextNode);

        // Queue for further traversal
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }
    }

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Traverse the graph using depth-first search
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  async traverseDFS(startId: string, options: TraversalOptions = {}): Promise<Subgraph> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = await this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    await this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * Recursive DFS helper
   */
  private async dfsRecursive(
    node: Node,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    // Get adjacent edges
    const adjacentEdges = await this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

    for (const edge of adjacentEdges) {
      // Determine next node: for 'both' direction, edges can be either
      // incoming or outgoing, so pick whichever end is not the current node
      const nextNodeId = edge.source === node.id ? edge.target : edge.source;

      if (visited.has(nextNodeId)) {
        continue;
      }

      const nextNode = await this.queries.getNodeById(nextNodeId);
      if (!nextNode) {
        continue;
      }

      // Apply node kind filter
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      // Add node and edge to result
      nodes.set(nextNode.id, nextNode);
      edges.push(edge);

      // Recurse
      await this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  /**
   * Get adjacent edges based on direction
   */
  private async getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): Promise<Edge[]> {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return await this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return await this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      // Both directions
      const outgoing = await this.queries.getOutgoingEdges(nodeId, kinds);
      const incoming = await this.queries.getIncomingEdges(nodeId, kinds);
      return [...outgoing, ...incoming];
    }
  }

  /**
   * Find all callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  async getCallers(nodeId: string, maxDepth: number = 1): Promise<Array<{ node: Node; edge: Edge }>> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    await this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private async getCallersRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = await this.queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports']);

    for (const edge of incomingEdges) {
      const callerNode = await this.queries.getNodeById(edge.source);
      if (callerNode && !visited.has(callerNode.id)) {
        result.push({ node: callerNode, edge });
        await this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * Find all functions/methods called by a function
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  async getCallees(nodeId: string, maxDepth: number = 1): Promise<Array<{ node: Node; edge: Edge }>> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    await this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private async getCalleesRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports']);

    for (const edge of outgoingEdges) {
      const calleeNode = await this.queries.getNodeById(edge.target);
      if (calleeNode && !visited.has(calleeNode.id)) {
        result.push({ node: calleeNode, edge });
        await this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * Get the call graph for a function (both callers and callees)
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  async getCallGraph(nodeId: string, depth: number = 2): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get callers
    const callers = await this.getCallers(nodeId, depth);
    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    // Get callees
    const callees = await this.getCallees(nodeId, depth);
    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  async getTypeHierarchy(nodeId: string): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Get ancestors (what this extends/implements)
    await this.getTypeAncestors(nodeId, nodes, edges, visited);

    // Get descendants (what extends/implements this)
    await this.getTypeDescendants(nodeId, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private async getTypeAncestors(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = await this.queries.getOutgoingEdges(nodeId, ['extends', 'implements']);

    for (const edge of outgoingEdges) {
      const parentNode = await this.queries.getNodeById(edge.target);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        await this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private async getTypeDescendants(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = await this.queries.getIncomingEdges(nodeId, ['extends', 'implements']);

    for (const edge of incomingEdges) {
      const childNode = await this.queries.getNodeById(edge.source);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        await this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  /**
   * Find all usages of a symbol
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  async findUsages(nodeId: string): Promise<Array<{ node: Node; edge: Edge }>> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    // Get all incoming edges (references, calls, type_of, etc.)
    const incomingEdges = await this.queries.getIncomingEdges(nodeId);

    for (const edge of incomingEdges) {
      const sourceNode = await this.queries.getNodeById(edge.source);
      if (sourceNode) {
        result.push({ node: sourceNode, edge });
      }
    }

    return result;
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  async getImpactRadius(nodeId: string, maxDepth: number = 3): Promise<Subgraph> {
    const focalNode = await this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // Add focal node
    nodes.set(focalNode.id, focalNode);

    // Traverse incoming edges to find all dependents
    await this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private async getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): Promise<void> {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // For container nodes (classes, interfaces, structs, etc.), also traverse
    // into their children so that callers of contained methods appear in impact
    const focalNode = await this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = await this.queries.getOutgoingEdges(nodeId, ['contains']);
        for (const edge of containsEdges) {
          const childNode = await this.queries.getNodeById(edge.target);
          if (childNode && !visited.has(childNode.id)) {
            nodes.set(childNode.id, childNode);
            edges.push(edge);
            // Recurse into children at the same depth (they're part of the same symbol)
            await this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
          }
        }
      }
    }

    // Get all incoming edges (things that depend on this node)
    const incomingEdges = await this.queries.getIncomingEdges(nodeId);

    for (const edge of incomingEdges) {
      const sourceNode = await this.queries.getNodeById(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        await this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  async findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = []
  ): Promise<Array<{ node: Node; edge: Edge | null }> | null> {
    const fromNode = await this.queries.getNodeById(fromId);
    const toNode = await this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // BFS to find shortest path
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: Array<{ node: Node; edge: Edge | null }> }> = [
      { nodeId: fromId, path: [{ node: fromNode, edge: null }] },
    ];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;

      if (nodeId === toId) {
        return path;
      }

      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      // Get outgoing edges
      const outgoingEdges = await this.queries.getOutgoingEdges(
        nodeId,
        edgeKinds.length > 0 ? edgeKinds : undefined
      );

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          const nextNode = await this.queries.getNodeById(edge.target);
          if (nextNode) {
            queue.push({
              nodeId: edge.target,
              path: [...path, { node: nextNode, edge }],
            });
          }
        }
      }
    }

    return null; // No path found
  }

  /**
   * Get the containment hierarchy for a node (ancestors)
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  async getAncestors(nodeId: string): Promise<Node[]> {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      // Look for 'contains' edges pointing to this node
      const containingEdges = await this.queries.getIncomingEdges(currentId, ['contains']);

      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      // Typically there should be at most one containing parent
      const parentNode = await this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  async getChildren(nodeId: string): Promise<Node[]> {
    const containsEdges = await this.queries.getOutgoingEdges(nodeId, ['contains']);
    const children: Node[] = [];

    for (const edge of containsEdges) {
      const childNode = await this.queries.getNodeById(edge.target);
      if (childNode) {
        children.push(childNode);
      }
    }

    return children;
  }
}
