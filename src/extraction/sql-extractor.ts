import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId, getNodeText } from './tree-sitter-helpers';
import { getParser } from './grammars';

/**
 * SqlExtractor — extracts SQL DDL into the graph.
 *
 * SQL is declarative, with no functions/classes/methods in the OO sense, so
 * this is a self-contained extractor (same shape as `LiquidExtractor` /
 * `HclExtractor`) rather than a `LanguageExtractor` config plug-in.
 *
 * Top-level statements become graph nodes whose qualified names follow the
 * SQL identifier they declare (with schema prefix when given):
 *
 *   SQL statement                          | NodeKind    | qualified name
 *   ---------------------------------------|-------------|-----------------
 *   CREATE TABLE [schema.]name             | class       | [schema.]name
 *   CREATE VIEW [schema.]name              | class       | [schema.]name
 *   CREATE FUNCTION [schema.]name(...)     | function    | [schema.]name
 *   CREATE TRIGGER name ON table           | function    | name
 *   CREATE TYPE name AS ENUM (...)         | enum        | name
 *   CREATE TYPE name AS ...                | type_alias  | name
 *   CREATE SCHEMA name                     | namespace   | name
 *
 * References emitted:
 *   - Foreign keys (`REFERENCES other_table`)            → `references`
 *   - View source tables (FROM/JOIN, including derived)  → `references`
 *   - Function body table mentions                       → `references`
 *   - Trigger target table                               → `references`
 *   - Trigger executed function                          → `calls`
 *
 * The grammar (DerekStride/tree-sitter-sql) covers ANSI SQL plus common
 * PostgreSQL/MySQL/SQLite/T-SQL syntax for tables, views, functions,
 * triggers, types, and schemas. CREATE PROCEDURE syntax varies sharply
 * across dialects (PL/pgSQL dollar-quoting, T-SQL BEGIN/END, MySQL
 * delimiter blocks) and is not currently parsed by the grammar — those
 * statements produce ERROR nodes and no extracted symbol. Plain DML
 * (SELECT/INSERT/UPDATE/DELETE) outside a CREATE body is recognized but
 * not emitted as nodes — those aren't symbol declarations.
 */
export class SqlExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('sql');
    if (!parser) {
      this.errors.push({ message: 'SQL grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }

    let tree;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `SQL parse error: ${e instanceof Error ? e.message : String(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'SQL parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode();
      const root = tree.rootNode;
      for (let i = 0; i < root.namedChildCount; i++) {
        const child = root.namedChild(i);
        if (child?.type !== 'statement') continue;
        try {
          this.visitStatement(child, fileNodeId);
        } catch (e) {
          this.errors.push({
            message: `SQL statement extraction error: ${e instanceof Error ? e.message : String(e)}`,
            line: child.startPosition.row + 1,
            severity: 'warning',
            code: 'extraction_error',
          });
        }
      }
      return this.result(startTime);
    } finally {
      tree.delete();
    }
  }

  private result(startTime: number): ExtractionResult {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): string {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    this.nodes.push({
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'sql',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    });
    return id;
  }

  private visitStatement(stmt: SyntaxNode, fileNodeId: string): void {
    const inner = stmt.namedChild(0);
    if (!inner) return;
    switch (inner.type) {
      case 'create_table':
        this.emitTable(inner, fileNodeId);
        return;
      case 'create_view':
        this.emitView(inner, fileNodeId);
        return;
      case 'create_function':
        this.emitFunction(inner, fileNodeId, 'CREATE FUNCTION');
        return;
      case 'create_trigger':
        this.emitTrigger(inner, fileNodeId);
        return;
      case 'create_type':
        this.emitType(inner, fileNodeId);
        return;
      case 'create_schema':
        this.emitSchema(inner, fileNodeId);
        return;
      // create_index, select, insert, update, delete, etc. are not
      // emitted as nodes — they aren't useful symbols for code intelligence.
      default:
        return;
    }
  }

  private emitTable(node: SyntaxNode, fileNodeId: string): void {
    const name = this.readObjectName(node);
    if (!name) return;
    const tableId = this.createNode('class', name, node, fileNodeId, `CREATE TABLE ${name}`);
    if (!tableId) return;

    // Foreign key references — `REFERENCES <table>` may appear inline on a
    // column_definition or as a separate `constraint` block under
    // column_definitions. Walk the whole subtree looking for object_reference
    // nodes that follow a `keyword_references` sibling.
    const cols = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'column_definitions');
    if (cols) {
      this.scanForeignKeys(cols, tableId);
    }
  }

  private emitView(node: SyntaxNode, fileNodeId: string): void {
    const name = this.readObjectName(node);
    if (!name) return;
    const viewId = this.createNode('class', name, node, fileNodeId, `CREATE VIEW ${name}`);
    if (!viewId) return;

    const query = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'create_query');
    if (query) this.scanQueryReferences(query, viewId);
  }

  private emitFunction(node: SyntaxNode, fileNodeId: string, label: string): void {
    const name = this.readObjectName(node);
    if (!name) return;
    const args = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'function_arguments');
    const argsText = args ? getNodeText(args, this.source) : '()';
    const funcId = this.createNode('function', name, node, fileNodeId, `${label} ${name}${argsText}`);
    if (!funcId) return;

    // Function bodies are often dollar-quoted plpgsql; the parser surfaces
    // any tables/columns it can recognize as `relation`/`object_reference`
    // even inside ERROR sub-trees. Pull out cross-references opportunistically.
    const body = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'function_body');
    if (body) this.scanQueryReferences(body, funcId);
  }

  private emitTrigger(node: SyntaxNode, fileNodeId: string): void {
    // create_trigger has multiple object_reference children. The trigger
    // name comes first (the only one before any keyword_on / keyword_execute).
    // The target table is the first object_reference *after* a keyword_on,
    // and the executed function is the first object_reference after a
    // keyword_execute. Indexing by position alone is fragile because
    // variants like `BEFORE UPDATE OF col1, col2 ON tbl ...` can interleave
    // identifiers/object_references for column lists.
    const nameNode = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference');
    if (!nameNode) return;
    const name = this.qualifiedName(nameNode);
    if (!name) return;

    const triggerId = this.createNode('function', name, node, fileNodeId, `CREATE TRIGGER ${name}`);
    if (!triggerId) return;

    const targetTable = this.findObjectRefAfter(node, 'keyword_on');
    if (targetTable) {
      const targetName = this.qualifiedName(targetTable);
      if (targetName) {
        this.unresolvedReferences.push({
          fromNodeId: triggerId,
          referenceName: targetName,
          referenceKind: 'references',
          line: targetTable.startPosition.row + 1,
          column: targetTable.startPosition.column,
        });
      }
    }

    const executedFn = this.findObjectRefAfter(node, 'keyword_execute');
    if (executedFn) {
      const fnName = this.qualifiedName(executedFn);
      if (fnName) {
        this.unresolvedReferences.push({
          fromNodeId: triggerId,
          referenceName: fnName,
          referenceKind: 'calls',
          line: executedFn.startPosition.row + 1,
          column: executedFn.startPosition.column,
        });
      }
    }
  }

  /**
   * Find the first `object_reference` named child that comes after a child
   * of type `markerType`. Returns null if no marker or no following ref.
   */
  private findObjectRefAfter(parent: SyntaxNode, markerType: string): SyntaxNode | null {
    let seenMarker = false;
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (!child) continue;
      if (child.type === markerType) {
        seenMarker = true;
        continue;
      }
      if (seenMarker && child.type === 'object_reference') return child;
    }
    return null;
  }

  private emitType(node: SyntaxNode, fileNodeId: string): void {
    const name = this.readObjectName(node);
    if (!name) return;
    const isEnum = node.namedChildren.some((c: SyntaxNode | null) => c?.type === 'keyword_enum');
    const kind: NodeKind = isEnum ? 'enum' : 'type_alias';
    this.createNode(kind, name, node, fileNodeId, `CREATE TYPE ${name}`);
  }

  private emitSchema(node: SyntaxNode, fileNodeId: string): void {
    // `create_schema` uses a plain `identifier` for the schema name, not
    // `object_reference` — schemas have no qualifying parent.
    const ident = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!ident) return;
    const name = getNodeText(ident, this.source);
    this.createNode('namespace', name, node, fileNodeId, `CREATE SCHEMA ${name}`);
  }

  /**
   * Scan a column_definitions subtree for foreign-key references. Looks for
   * a `keyword_references` token followed by an `object_reference` (that's
   * the canonical FK shape both for inline `col INT REFERENCES ...` and for
   * standalone `CONSTRAINT ... FOREIGN KEY (...) REFERENCES ...`).
   */
  private scanForeignKeys(root: SyntaxNode, fromNodeId: string): void {
    const visit = (node: SyntaxNode): void => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'keyword_references') {
          const target = node.namedChild(i + 1);
          if (target?.type === 'object_reference') {
            const targetName = this.qualifiedName(target);
            if (targetName) {
              this.unresolvedReferences.push({
                fromNodeId,
                referenceName: targetName,
                referenceKind: 'references',
                line: target.startPosition.row + 1,
                column: target.startPosition.column,
              });
            }
          }
        }
        visit(child);
      }
    };
    visit(root);
  }

  /**
   * Scan an arbitrary subtree (view body, function body, etc.) for table
   * mentions. A `relation` always wraps a table reference in DML, and any
   * naked `object_reference` outside the head position of a CREATE statement
   * counts as a reference too. Subqueries inside `relation` (derived tables,
   * CTEs) have no direct `object_reference` but contain inner `relation`s
   * we must keep walking into.
   */
  private scanQueryReferences(root: SyntaxNode, fromNodeId: string): void {
    const seen = new Set<string>();
    const visit = (node: SyntaxNode): void => {
      let recordedRelationHead = false;
      if (node.type === 'relation' || node.type === 'object_reference') {
        const target = node.type === 'relation'
          ? node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference')
          : node;
        if (target) {
          const targetName = this.qualifiedName(target);
          // De-dup per source — a view that mentions `users` five times
          // shouldn't produce five edges to the same target.
          if (targetName && !seen.has(targetName)) {
            seen.add(targetName);
            this.unresolvedReferences.push({
              fromNodeId,
              referenceName: targetName,
              referenceKind: 'references',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
          recordedRelationHead = node.type === 'relation';
        }
        // If we matched a `relation` to a real table, don't descend — the
        // inner object_reference IS the head, not a nested reference.
        // But if the `relation` had no object_reference child (subquery /
        // derived table), keep walking so we pick up tables inside it.
        if (recordedRelationHead) return;
      }
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child);
      }
    };
    visit(root);
  }

  /**
   * Read the head `object_reference` of a CREATE statement and return its
   * qualified name (e.g. `reporting.events`). Returns null if the parser
   * couldn't extract one.
   */
  private readObjectName(node: SyntaxNode): string | null {
    const ref = node.namedChildren.find((c: SyntaxNode | null) => c?.type === 'object_reference');
    if (!ref) return null;
    return this.qualifiedName(ref);
  }

  /**
   * Render an `object_reference` as a dotted qualified name. The grammar
   * exposes 1 identifier child for an unqualified name, 2 for `schema.name`,
   * and occasionally 3 for `db.schema.name` in some dialects.
   */
  private qualifiedName(ref: SyntaxNode): string | null {
    const idents = ref.namedChildren.filter((c: SyntaxNode | null) => c?.type === 'identifier');
    if (idents.length === 0) {
      // Some grammar versions surface the name as raw text on the
      // object_reference itself when there are no identifier children.
      const text = getNodeText(ref, this.source).trim();
      return text || null;
    }
    return idents.map((i: SyntaxNode) => getNodeText(i, this.source)).join('.');
  }

  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    fileNodeId: string,
    signature: string,
    extra?: Partial<Node>,
  ): string | null {
    if (!name) return null;
    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);
    this.nodes.push({
      id,
      kind,
      name,
      qualifiedName: name,
      filePath: this.filePath,
      language: 'sql',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      signature,
      updatedAt: Date.now(),
      ...extra,
    });
    this.edges.push({ source: fileNodeId, target: id, kind: 'contains' });
    return id;
  }
}
