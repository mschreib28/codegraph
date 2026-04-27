import type { Node as SyntaxNode } from 'web-tree-sitter';
import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, NodeKind } from '../types';
import { generateNodeId, getNodeText } from './tree-sitter-helpers';
import { getParser } from './grammars';

/**
 * HclExtractor — extracts a Terraform/HCL file into the graph.
 *
 * HCL is a declarative configuration language: there are no functions,
 * classes, or methods. The unit of structure is the **block**:
 *
 *     <kind> [<label>...] { <body> }
 *
 * Each top-level block is mapped to a graph node, with its qualified name
 * matching the Terraform reference form so cross-block references resolve
 * naturally:
 *
 *   block form                        | NodeKind   | qualified name
 *   ----------------------------------|------------|----------------------
 *   variable "x" {}                   | variable   | var.x
 *   locals { x = ...; y = ... }       | constant   | local.x, local.y
 *   resource "TYPE" "NAME" {}         | class      | TYPE.NAME
 *   data "TYPE" "NAME" {}             | class      | data.TYPE.NAME
 *   module "NAME" {}                  | module     | module.NAME
 *   output "NAME" {}                  | export     | output.NAME
 *   provider "NAME" {}                | namespace  | provider.NAME
 *   terraform {}                      | module     | terraform
 *
 * References inside attribute values (e.g. `bucket = aws_s3_bucket.logs.id`)
 * become unresolved references that the resolver matches by qualified name.
 */
export class HclExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  /**
   * Heads that look like references but are Terraform built-ins / pseudo-vars,
   * not addressable graph nodes. Skipped during reference scanning.
   *
   * `terraform` is in this set because `terraform.workspace` is a built-in
   * pseudo-var. As a side effect, the `terraform {}` block node we emit
   * (qualifiedName=`terraform`) cannot be the target of a resolved reference
   * — that's intentional, since Terraform itself doesn't allow blocks to
   * reference the terraform settings block.
   */
  private static readonly RESERVED_HEADS: ReadonlySet<string> = new Set([
    'count',
    'each',
    'self',
    'path',
    'terraform',
    'null',
    'true',
    'false',
  ]);

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('hcl');
    if (!parser) {
      this.errors.push({
        message: 'HCL grammar not loaded',
        severity: 'error',
        code: 'grammar_unavailable',
      });
      return this.result(startTime);
    }

    let tree;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `HCL parse error: ${e instanceof Error ? e.message : String(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'HCL parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode();

      const root = tree.rootNode;
      const topBody = root.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body');
      if (!topBody) {
        return this.result(startTime);
      }

      for (let i = 0; i < topBody.namedChildCount; i++) {
        const child = topBody.namedChild(i);
        if (child?.type === 'block') {
          try {
            this.visitTopLevelBlock(child, fileNodeId);
          } catch (e) {
            this.errors.push({
              message: `HCL block extraction error: ${e instanceof Error ? e.message : String(e)}`,
              line: child.startPosition.row + 1,
              severity: 'warning',
              code: 'extraction_error',
            });
          }
        }
      }

      return this.result(startTime);
    } finally {
      // tree-sitter trees back onto WASM linear memory; release them explicitly
      // so we don't accumulate one tree per indexed .tf file.
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
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'hcl',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return id;
  }

  /**
   * Handle a single top-level block, dispatching by block kind.
   * Block AST shape:
   *   block
   *     identifier         (the kind: "resource", "variable", ...)
   *     string_lit*        (zero, one, or two labels)
   *     body               (optional — empty `{}` blocks have no body child)
   */
  private visitTopLevelBlock(block: SyntaxNode, fileNodeId: string): void {
    const head = block.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!head) return;
    const kind = getNodeText(head, this.source);

    const labels: string[] = [];
    for (const child of block.namedChildren) {
      if (child?.type === 'string_lit') labels.push(this.unquoteStringLit(child));
    }
    const body = block.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body') ?? null;

    switch (kind) {
      case 'resource':
        this.emitTypedBlock(block, body, fileNodeId, labels, /*qnPrefix*/ '', 'resource');
        return;
      case 'data':
        this.emitTypedBlock(block, body, fileNodeId, labels, 'data.', 'data');
        return;
      case 'module':
        this.emitNamedBlock(block, body, fileNodeId, labels, 'module', 'module.', 'module');
        return;
      case 'variable':
        this.emitNamedBlock(block, body, fileNodeId, labels, 'variable', 'var.', 'variable');
        return;
      case 'output':
        this.emitNamedBlock(block, body, fileNodeId, labels, 'export', 'output.', 'output');
        return;
      case 'provider':
        this.emitNamedBlock(block, body, fileNodeId, labels, 'namespace', 'provider.', 'provider');
        return;
      case 'locals':
        this.emitLocalsBlock(body, fileNodeId);
        return;
      case 'terraform':
        this.emitTerraformBlock(block, body, fileNodeId);
        return;
      default:
        // Unknown top-level block kind (vendor extensions, etc.).
        // Emit as a generic namespace node so it shows up in search.
        this.emitNamedBlock(block, body, fileNodeId, labels, 'namespace', `${kind}.`, kind);
    }
  }

  /**
   * `resource "TYPE" "NAME" {}` and `data "TYPE" "NAME" {}` — both take two labels.
   */
  private emitTypedBlock(
    block: SyntaxNode,
    body: SyntaxNode | null,
    fileNodeId: string,
    labels: string[],
    qnPrefix: string,
    blockKind: string,
  ): void {
    if (labels.length < 2) return;
    const [type, name] = labels;
    const localName = `${type}.${name}`;
    const qualifiedName = `${qnPrefix}${localName}`;
    const nodeId = generateNodeId(this.filePath, 'class', qualifiedName, block.startPosition.row + 1);

    const node: Node = {
      id: nodeId,
      kind: 'class',
      name: localName,
      qualifiedName,
      filePath: this.filePath,
      language: 'hcl',
      startLine: block.startPosition.row + 1,
      endLine: block.endPosition.row + 1,
      startColumn: block.startPosition.column,
      endColumn: block.endPosition.column,
      signature: `${blockKind} "${type}" "${name}"`,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

    if (body) this.scanBodyForReferences(body, nodeId);
  }

  /**
   * Single-label blocks: variable, output, provider, module, plus unknown kinds.
   * `module` blocks additionally emit an `imports` reference for `source = "..."`.
   */
  private emitNamedBlock(
    block: SyntaxNode,
    body: SyntaxNode | null,
    fileNodeId: string,
    labels: string[],
    nodeKind: NodeKind,
    qnPrefix: string,
    blockKind: string,
  ): void {
    if (labels.length < 1) return;
    const name = labels[0]!;
    const qualifiedName = `${qnPrefix}${name}`;
    const nodeId = generateNodeId(this.filePath, nodeKind, qualifiedName, block.startPosition.row + 1);

    const node: Node = {
      id: nodeId,
      kind: nodeKind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'hcl',
      startLine: block.startPosition.row + 1,
      endLine: block.endPosition.row + 1,
      startColumn: block.startPosition.column,
      endColumn: block.endPosition.column,
      signature: `${blockKind} "${name}"`,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

    if (body) {
      if (blockKind === 'module') this.emitModuleSourceImport(body, nodeId);
      this.scanBodyForReferences(body, nodeId);
    }
  }

  /**
   * `locals { a = ...; b = ... }` — each top-level attribute becomes a
   * separate `constant` node with qualified name `local.<attr>`.
   */
  private emitLocalsBlock(body: SyntaxNode | null, fileNodeId: string): void {
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child?.type !== 'attribute') continue;
      const nameNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      const qualifiedName = `local.${name}`;
      const nodeId = generateNodeId(this.filePath, 'constant', qualifiedName, child.startPosition.row + 1);

      const node: Node = {
        id: nodeId,
        kind: 'constant',
        name,
        qualifiedName,
        filePath: this.filePath,
        language: 'hcl',
        startLine: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
        startColumn: child.startPosition.column,
        endColumn: child.endPosition.column,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      const exprNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
      if (exprNode) this.scanExpressionForReferences(exprNode, nodeId);
    }
  }

  /**
   * `terraform { ... }` — anchor block with no labels. We emit a single
   * module-kind node so the file shows up in search; nested
   * required_providers / backend blocks are not enumerated for v1.
   */
  private emitTerraformBlock(block: SyntaxNode, _body: SyntaxNode | null, fileNodeId: string): void {
    const qualifiedName = 'terraform';
    const nodeId = generateNodeId(this.filePath, 'module', qualifiedName, block.startPosition.row + 1);
    const node: Node = {
      id: nodeId,
      kind: 'module',
      name: 'terraform',
      qualifiedName,
      filePath: this.filePath,
      language: 'hcl',
      startLine: block.startPosition.row + 1,
      endLine: block.endPosition.row + 1,
      startColumn: block.startPosition.column,
      endColumn: block.endPosition.column,
      signature: 'terraform',
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  }

  /**
   * For a `module "X" { source = "..." }` block, emit an `imports` edge to
   * the source string. Cross-file resolution isn't yet HCL-aware, so we
   * emit it as an unresolved reference using the literal source value.
   */
  private emitModuleSourceImport(body: SyntaxNode, fromNodeId: string): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      const attr = body.namedChild(i);
      if (attr?.type !== 'attribute') continue;
      const nameNode = attr.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
      if (!nameNode || getNodeText(nameNode, this.source) !== 'source') continue;

      const exprNode = attr.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
      if (!exprNode) return;
      const literal = this.extractStaticString(exprNode);
      if (literal === null) return;

      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: literal,
        referenceKind: 'imports',
        line: attr.startPosition.row + 1,
        column: attr.startPosition.column,
      });
      return;
    }
  }

  private scanBodyForReferences(body: SyntaxNode, fromNodeId: string): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;
      if (child.type === 'attribute') {
        const exprNode = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'expression');
        if (exprNode) this.scanExpressionForReferences(exprNode, fromNodeId);
      } else if (child.type === 'block') {
        // Nested block (e.g. `versioning_configuration { ... }` inside a resource).
        // Walk its body recursively, but don't emit a separate node — the parent
        // block owns the sub-config.
        const nestedBody = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'body');
        if (nestedBody) this.scanBodyForReferences(nestedBody, fromNodeId);
      }
    }
  }

  /**
   * Walk an `expression` subtree and emit unresolved references for each
   * Terraform-style address head we find. References take the form:
   *
   *   <head_identifier>(.<get_attr>)*
   *
   * which the parser exposes as a `variable_expr` node followed by sibling
   * `get_attr` / `index` / `splat` nodes within the same `expression`.
   *
   * Loop-bound iteration variables (e.g. `s` in `[for s in xs : s.id]`,
   * `k` and `v` in `{for k, v in m : k => v}`) are tracked in `bindings`
   * so they don't generate spurious references.
   */
  private scanExpressionForReferences(
    root: SyntaxNode,
    fromNodeId: string,
    loopBindings: ReadonlySet<string> = new Set(),
  ): void {
    const visit = (node: SyntaxNode, bindings: ReadonlySet<string>): void => {
      if (node.type === 'expression') {
        const ref = this.tryExtractReference(node, bindings);
        if (ref) {
          this.unresolvedReferences.push({
            fromNodeId,
            referenceName: ref.name,
            referenceKind: 'references',
            line: ref.line,
            column: ref.column,
          });
        }
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visit(child, bindings);
        }
        return;
      }

      // for_expr: identifiers introduced in `for_intro` are bound for the
      // rest of the for body (and any condition), but NOT for the iterable
      // expression inside the for_intro itself.
      if (node.type === 'for_tuple_expr' || node.type === 'for_object_expr') {
        let activeBindings = bindings;
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          if (child.type === 'for_intro') {
            activeBindings = this.visitForIntro(child, bindings, fromNodeId);
          } else {
            visit(child, activeBindings);
          }
        }
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) visit(child, bindings);
      }
    };

    visit(root, loopBindings);
  }

  /**
   * Process a `for_intro` node and return the binding set in scope for the
   * enclosing for-expression's body and condition. The iterable expression
   * inside the for_intro is scanned with the *outer* bindings — iteration
   * variables aren't yet in scope at that point.
   */
  private visitForIntro(
    forIntro: SyntaxNode,
    outerBindings: ReadonlySet<string>,
    fromNodeId: string,
  ): ReadonlySet<string> {
    const newBindings = new Set(outerBindings);
    for (let i = 0; i < forIntro.namedChildCount; i++) {
      const child = forIntro.namedChild(i);
      if (child?.type === 'identifier') {
        newBindings.add(getNodeText(child, this.source));
      } else if (child?.type === 'expression') {
        // The iterable: scan with the original (outer) bindings.
        this.scanExpressionForReferences(child, fromNodeId, outerBindings);
      }
    }
    return newBindings;
  }

  /**
   * If `expression` is `<variable_expr> (<get_attr>|<index>|<splat>)*`,
   * return the Terraform-style address it references. Otherwise null.
   *
   * The reference name follows Terraform's addressing scheme so it can match
   * the qualified names of the block nodes we emit:
   *   - var.X            → variable X
   *   - local.X          → local X
   *   - module.X         → module X (trailing get_attr is the output name)
   *   - data.T.N         → data block T/N
   *   - count/each/self/path/terraform → reserved, skipped
   *   - <ident>.N        → resource <ident>.N
   *
   * We stop at the address head (e.g. `aws_s3_bucket.logs` from
   * `aws_s3_bucket.logs.id`) so the resolver can match against block-node
   * qualified names without per-attribute noise.
   */
  private tryExtractReference(
    expression: SyntaxNode,
    bindings: ReadonlySet<string>,
  ): { name: string; line: number; column: number } | null {
    if (expression.namedChildCount === 0) return null;
    const first = expression.namedChild(0);
    if (first?.type !== 'variable_expr') return null;

    const headIdent = first.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
    if (!headIdent) return null;
    const head = getNodeText(headIdent, this.source);
    if (HclExtractor.RESERVED_HEADS.has(head) || bindings.has(head)) return null;

    // Walk the get_attr chain until we have enough to address the resource/module/var/etc.
    const chain: string[] = [];
    for (let i = 1; i < expression.namedChildCount; i++) {
      const child = expression.namedChild(i);
      if (child?.type !== 'get_attr') break;
      const attrIdent = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'identifier');
      if (!attrIdent) break;
      chain.push(getNodeText(attrIdent, this.source));
    }

    let name: string | null = null;
    if (head === 'var' || head === 'local') {
      // var.X or local.X
      if (chain.length >= 1) name = `${head}.${chain[0]}`;
    } else if (head === 'module') {
      if (chain.length >= 1) name = `module.${chain[0]}`;
    } else if (head === 'data') {
      if (chain.length >= 2) name = `data.${chain[0]}.${chain[1]}`;
    } else {
      // Resource: <type>.<name>
      if (chain.length >= 1) name = `${head}.${chain[0]}`;
    }

    if (!name) return null;
    return {
      name,
      line: first.startPosition.row + 1,
      column: first.startPosition.column,
    };
  }

  /**
   * Pull a literal string out of an expression of the form `"..."`.
   * Returns null for interpolated, non-string, or otherwise dynamic values
   * (we don't attempt module-source resolution on dynamic strings).
   *
   * The grammar uses two shapes for quoted strings:
   *   - `expression > literal_value > string_lit`            (no interpolations)
   *   - `expression > template_expr > quoted_template`       (with interpolations)
   * In both, the body comes from `template_literal` children; presence of any
   * `template_interpolation`/`template_directive` makes the value dynamic.
   */
  private extractStaticString(expression: SyntaxNode): string | null {
    const child = expression.namedChild(0);
    if (!child) return null;

    let container: SyntaxNode | null = null;
    if (child.type === 'literal_value') {
      const stringLit = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'string_lit');
      container = stringLit ?? null;
    } else if (child.type === 'template_expr') {
      const quoted = child.namedChildren.find((c: SyntaxNode | null) => c?.type === 'quoted_template');
      container = quoted ?? null;
    }
    if (!container) return null;

    let literal = '';
    for (let i = 0; i < container.namedChildCount; i++) {
      const part = container.namedChild(i);
      if (!part) continue;
      if (part.type === 'template_literal') {
        literal += getNodeText(part, this.source);
      } else if (part.type === 'template_interpolation' || part.type === 'template_directive') {
        return null;
      }
    }
    return literal;
  }

  private unquoteStringLit(node: SyntaxNode): string {
    const text = getNodeText(node, this.source);
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
      return text.slice(1, -1);
    }
    return text;
  }
}
