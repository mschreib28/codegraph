/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 */

import { EdgeKind, Language, Node } from '../types';

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string;
  /** The name being referenced */
  referenceName: string;
  /** Type of reference */
  referenceKind: EdgeKind;
  /** Line where reference occurs */
  line: number;
  /** Column where reference occurs */
  column: number;
  /** File path where reference occurs */
  filePath: string;
  /** Language of the source file */
  language: Language;
  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

/**
 * A resolved reference
 */
export interface ResolvedRef {
  /** Original unresolved reference */
  original: UnresolvedRef;
  /** ID of the target node */
  targetNodeId: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How it was resolved */
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path';
}

/**
 * Result of resolution attempt
 */
export interface ResolutionResult {
  /** Successfully resolved references */
  resolved: ResolvedRef[];
  /** References that couldn't be resolved */
  unresolved: UnresolvedRef[];
  /** Statistics */
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

/**
 * Context for resolution - provides access to the graph
 */
export interface ResolutionContext {
  /** Get all nodes in a file */
  getNodesInFile(filePath: string): Node[];
  /** Get all nodes by name */
  getNodesByName(name: string): Node[];
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** Get all nodes of a kind */
  getNodesByKind(kind: Node['kind']): Node[];
  /** Check if a file exists */
  fileExists(filePath: string): boolean;
  /** Read file content */
  readFile(filePath: string): string | null;
  /** Get project root */
  getProjectRoot(): string;
  /** Get all files */
  getAllFiles(): string[];
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): Node[];
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
}

/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: Node[];
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[];
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: Language[];
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean;
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * Extract framework-specific nodes and references from a file.
   *
   * Returns route nodes, middleware nodes, etc., plus unresolved references
   * that link those nodes to handlers (view classes, controller methods,
   * included modules). Unresolved references flow into the normal resolution
   * pipeline; the framework's own `resolve()` is one of the strategies tried.
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
}

/**
 * Import mapping from a file
 */
export interface ImportMapping {
  /** Local name used in the file */
  localName: string;
  /** Original exported name (may differ due to aliasing) */
  exportedName: string;
  /** Source module/path */
  source: string;
  /** Whether it's a default import */
  isDefault: boolean;
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean;
  /** Resolved file path (if local) */
  resolvedPath?: string;
}
