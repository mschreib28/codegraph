/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported, getGrammarError } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

/**
 * Extract the name from a node based on language
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator(s) for C/C++ pointer return types
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

// ---------------------------------------------------------------------------
// extractInheritance helpers — module-scope so they're allocated once
// ---------------------------------------------------------------------------

type PushRef = (ref: UnresolvedReference) => void;

const EXTENDS_CHILD_TYPES = new Set([
  'extends_clause', 'superclass', 'base_clause', 'extends_interfaces',
]);
const IMPLEMENTS_CHILD_TYPES = new Set([
  'implements_clause', 'class_interface_clause', 'super_interfaces', 'interfaces',
]);
const CONTAINER_CHILD_TYPES = new Set(['field_declaration_list', 'class_heritage']);

function inheritanceExtends(child: SyntaxNode, classId: string, source: string, push: PushRef): void {
  const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
  const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
  for (const target of targets) {
    if (target) push({ fromNodeId: classId, referenceName: getNodeText(target, source), referenceKind: 'extends', line: target.startPosition.row + 1, column: target.startPosition.column });
  }
}

function inheritanceImplements(child: SyntaxNode, classId: string, source: string, push: PushRef): void {
  const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
  const targets = typeList ? typeList.namedChildren : child.namedChildren;
  for (const iface of targets) {
    if (iface) push({ fromNodeId: classId, referenceName: getNodeText(iface, source), referenceKind: 'implements', line: iface.startPosition.row + 1, column: iface.startPosition.column });
  }
}

type InheritanceChildHandler = (child: SyntaxNode, classId: string, source: string, push: PushRef) => void;

const INHERITANCE_HANDLERS: Record<string, InheritanceChildHandler> = {
  constraint_elem: (child, classId, source, push) => {
    const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    if (typeId) push({ fromNodeId: classId, referenceName: getNodeText(typeId, source), referenceKind: 'extends', line: typeId.startPosition.row + 1, column: typeId.startPosition.column });
  },
  field_declaration: (child, classId, source, push) => {
    if (child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier')) return;
    const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    if (typeId) push({ fromNodeId: classId, referenceName: getNodeText(typeId, source), referenceKind: 'extends', line: typeId.startPosition.row + 1, column: typeId.startPosition.column });
  },
  trait_bounds: (child, classId, source, push) => {
    for (const bound of child.namedChildren) {
      let typeName: string | undefined;
      let posNode: SyntaxNode | undefined;
      if (bound.type === 'type_identifier') {
        typeName = getNodeText(bound, source); posNode = bound;
      } else if (bound.type === 'generic_type') {
        const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (inner) { typeName = getNodeText(inner, source); posNode = inner; }
      } else if (bound.type === 'higher_ranked_trait_bound') {
        const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
        const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
          ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) { typeName = getNodeText(typeId, source); posNode = typeId; }
      }
      if (typeName && posNode) push({ fromNodeId: classId, referenceName: typeName, referenceKind: 'extends', line: posNode.startPosition.row + 1, column: posNode.startPosition.column });
    }
  },
  base_list: (child, classId, source, push) => {
    for (const baseType of child.namedChildren) {
      if (!baseType) continue;
      const name = baseType.type === 'generic_name'
        ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, source)
        : getNodeText(baseType, source);
      push({ fromNodeId: classId, referenceName: name, referenceKind: 'extends', line: baseType.startPosition.row + 1, column: baseType.startPosition.column });
    }
  },
  delegation_specifier: (child, classId, source, push) => {
    const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
    const ctorInv = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
    const target = userType ?? ctorInv;
    if (!target) return;
    const typeId = target.type === 'user_type'
      ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
      : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
        ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
    push({ fromNodeId: classId, referenceName: getNodeText(typeId, source), referenceKind: 'extends', line: typeId.startPosition.row + 1, column: typeId.startPosition.column });
  },
  inheritance_specifier: (child, classId, source, push) => {
    const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
    const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
    if (typeId) push({ fromNodeId: classId, referenceName: getNodeText(typeId, source), referenceKind: 'extends', line: typeId.startPosition.row + 1, column: typeId.startPosition.column });
  },
};

// ---------------------------------------------------------------------------

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup
  private nodeDispatch: Map<string, (node: SyntaxNode) => boolean> | null = null;
  private pascalDispatch: Map<string, (node: SyntaxNode) => boolean> | null = null;

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      const grammarErr = getGrammarError(this.language);
      const reason = grammarErr
        ? `grammar failed to load: ${grammarErr}`
        : 'grammar not loaded';
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `No parser for ${this.language} — ${reason}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'grammar_unavailable',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);
      this.visitNode(this.tree.rootNode);
      this.nodeStack.pop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM memory errors leave the module in a corrupted state — all subsequent
      // parses would also fail. Re-throw so the worker can detect and crash,
      // forcing a clean restart with a fresh heap.
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // Free tree-sitter WASM memory immediately — trees hold native heap memory
      // invisible to V8's GC that accumulates across thousands of files.
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      // Release source string to reduce GC pressure
      this.source = '';
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;
    if (this.extractor.visitNode?.(node, this.makeExtractorContext())) return;
    if (this.language === 'pascal' && this.visitPascalNode(node)) return;

    const handler = this.getNodeDispatch().get(node.type);
    if (handler?.(node)) return;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.visitNode(child);
    }
  }

  private getNodeDispatch(): Map<string, (node: SyntaxNode) => boolean> {
    if (!this.nodeDispatch) this.nodeDispatch = this.buildNodeDispatch();
    return this.nodeDispatch;
  }

  private buildNodeDispatch(): Map<string, (node: SyntaxNode) => boolean> {
    const map = new Map<string, (node: SyntaxNode) => boolean>();
    const e = this.extractor!;
    const functionAndMethodTypes = new Set(e.functionTypes.filter(t => e.methodTypes.includes(t)));

    const set = <T>(types: T[], factory: (t: T) => (node: SyntaxNode) => boolean) => {
      for (const t of types) if (!map.has(t as string)) map.set(t as string, factory(t));
    };

    for (const t of e.functionTypes) {
      map.set(t, node => {
        if (this.isInsideClassLikeNode() && functionAndMethodTypes.has(node.type)) {
          this.extractMethod(node);
        } else {
          this.extractFunction(node);
        }
        return true;
      });
    }
    set(e.classTypes, () => node => { this.dispatchClassNode(node); return true; });
    set(e.extraClassNodeTypes ?? [], () => node => { this.extractClass(node); return true; });
    set(e.methodTypes, () => node => { this.extractMethod(node); return true; });
    set(e.interfaceTypes, () => node => { this.extractInterface(node); return true; });
    set(e.structTypes, () => node => { this.extractStruct(node); return true; });
    set(e.enumTypes, () => node => { this.extractEnum(node); return true; });
    set(e.typeAliasTypes, () => node => this.extractTypeAlias(node));
    set(e.propertyTypes ?? [], () => node => {
      if (this.isInsideClassLikeNode()) { this.extractProperty(node); return true; }
      return false;
    });
    set(e.fieldTypes ?? [], () => node => {
      if (this.isInsideClassLikeNode()) { this.extractField(node); return true; }
      return false;
    });
    set(e.variableTypes, () => node => {
      if (!this.isInsideClassLikeNode()) { this.extractVariable(node); return true; }
      return false;
    });
    set(e.importTypes, () => node => { this.extractImport(node); return false; });
    set(e.callTypes, () => node => { this.extractCall(node); return false; });
    if (!map.has('export_statement')) map.set('export_statement', node => { this.extractExportedVariables(node); return false; });
    if (!map.has('impl_item')) map.set('impl_item', node => { this.extractRustImplItem(node); return false; });

    return map;
  }

  private dispatchClassNode(node: SyntaxNode): void {
    const cls = this.extractor!.classifyClassNode?.(node) ?? 'class';
    if (cls === 'struct') this.extractStruct(node);
    else if (cls === 'enum') this.extractEnum(node);
    else if (cls === 'interface') this.extractInterface(node);
    else if (cls === 'trait') this.extractClass(node, 'trait');
    else this.extractClass(node);
  }

  /**
   * Create a Node object
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
    // Build a qualified name from the semantic hierarchy only (no file path).
    // The file path is stored separately in filePath and pollutes FTS if included here.
    const parts: string[] = [];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node && node.kind !== 'file') {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Extract a function
   */
  private extractFunction(node: SyntaxNode): void {
    if (!this.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    let name = extractName(node, this.source, this.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') return; // Skip anonymous functions

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
    });
    if (!funcNode) return;

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, funcNode.id);

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, methodNode.id);

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    this.extractInheritance(node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
    this.extractInheritance(node, structNode.id);

    // Push to stack for field extraction
    this.nodeStack.push(structNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations and type references (no body = not a definition)
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // Extract inheritance (e.g. Swift: enum AFError: Error)
    this.extractInheritance(node, enumNode.id);

    // Push to stack and visit body children (enum members, nested types, methods)
    this.nodeStack.push(enumNode.id);

    const memberTypes = this.extractor.enumMemberTypes;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        this.extractEnumMembers(child);
      } else {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
  private extractEnumMembers(node: SyntaxNode): void {
    // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      this.createNode('enum_member', getNodeText(nameNode, this.source), node);
      return;
    }

    // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
    let found = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
        this.createNode('enum_member', getNodeText(child, this.source), child);
        found = true;
      }
    }

    // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
    if (!found && node.namedChildCount === 0) {
      this.createNode('enum_member', getNodeText(node, this.source), node);
    }
  }

  /**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
  private extractProperty(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // Property name is a direct identifier child
    const nameNode = getChildByField(node, 'name')
      || node.namedChildren.find(c => c.type === 'identifier');
    if (!nameNode) return;

    const name = getNodeText(nameNode, this.source);

    // Get property type from the type child (first named child that isn't modifier or identifier)
    const typeNode = node.namedChildren.find(
      c => c.type !== 'modifier' && c.type !== 'modifiers'
        && c.type !== 'identifier' && c.type !== 'accessor_list'
        && c.type !== 'accessors' && c.type !== 'equals_value_clause'
    );
    const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
    const signature = typeText ? `${typeText} ${name}` : name;

    this.createNode('property', name, node, {
      docstring,
      signature,
      visibility,
      isStatic,
    });
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // Java field_declaration: "private final String name = value;" → variable_declarator(s) are direct children
    // C# field_declaration: wraps in variable_declaration → variable_declarator(s)
    let declarators = node.namedChildren.filter(
      c => c.type === 'variable_declarator'
    );
    // C#: look inside variable_declaration wrapper
    if (declarators.length === 0) {
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      if (varDecl) {
        declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
      }
    }

    // PHP property_declaration: property_element → variable_name → name
    if (declarators.length === 0) {
      const propElements = node.namedChildren.filter(c => c.type === 'property_element');
      if (propElements.length > 0) {
        // Get type annotation if present (e.g. "string", "int", "?Foo")
        const typeNode = node.namedChildren.find(
          c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
            && c.type !== 'readonly_modifier' && c.type !== 'property_element'
            && c.type !== 'var_modifier'
        );
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        for (const elem of propElements) {
          const varName = elem.namedChildren.find(c => c.type === 'variable_name');
          const nameNode = varName?.namedChildren.find(c => c.type === 'name');
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          const signature = typeText ? `${typeText} $${name}` : `$${name}`;
          this.createNode('field', name, elem, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
        }
        return;
      }
    }

    if (declarators.length > 0) {
      // Get field type from the type child
      // Java: type is a direct child of field_declaration
      // C#: type is inside variable_declaration wrapper
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      const typeSearchNode = varDecl ?? node;
      const typeNode = typeSearchNode.namedChildren.find(
        c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
          && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const decl of declarators) {
        const nameNode = getChildByField(decl, 'name')
          || decl.namedChildren.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} ${name}` : name;
        this.createNode('field', name, decl, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
      }
    } else {
      // Fallback: try to find an identifier child directly
      const nameNode = getChildByField(node, 'name')
        || node.namedChildren.find(c => c.type === 'identifier');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        this.createNode('field', name, node, {
          docstring,
          visibility,
          isStatic,
        });
      }
    }
  }

  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;
    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    if (this.extractor.extractVariables) {
      for (const info of this.extractor.extractVariables(node, this.source)) {
        if (info.delegateToFunction) {
          this.extractFunction(info.delegateToFunction);
          continue;
        }
        const varNode = this.createNode(
          info.kind ?? kind,
          info.name,
          info.positionNode ?? node,
          { docstring, signature: info.signature, isExported },
        );
        if (varNode) this.extractVariableTypeAnnotation(info.positionNode ?? node, varNode.id);
      }
      return;
    }
    this.extractVariableGenericFallback(node, kind, docstring, isExported);
  }

  private extractVariableGenericFallback(
    node: SyntaxNode, kind: NodeKind, docstring: string | undefined, isExported: boolean,
  ): void {
    if (!this.extractor) return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
        const name = child.type === 'identifier'
          ? getNodeText(child, this.source)
          : extractName(child, this.source, this.extractor);
        if (name && name !== '<anonymous>') {
          this.createNode(kind, name, child, { docstring, isExported });
        }
      }
    }
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      this.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
      }
    }
    return false;
  }

  /**
   * Extract an exported variable declaration that isn't a function.
   * Handles patterns like:
   *   export const X = create(...)
   *   export const X = { ... }
   *   export const X = [...]
   *   export const X = "value"
   *
   * This is called for `export_statement` nodes that contain a
   * `lexical_declaration` with `variable_declarator` children whose
   * values are NOT already handled by functionTypes (arrow_function,
   * function_expression).
   */
  private extractExportedVariables(exportNode: SyntaxNode): void {
    if (!this.extractor) return;

    // Find the lexical_declaration or variable_declaration child
    for (let i = 0; i < exportNode.namedChildCount; i++) {
      const decl = exportNode.namedChild(i);
      if (!decl || (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration')) {
        continue;
      }

      // Iterate over each variable_declarator in the declaration
      for (let j = 0; j < decl.namedChildCount; j++) {
        const declarator = decl.namedChild(j);
        if (!declarator || declarator.type !== 'variable_declarator') continue;

        const nameNode = getChildByField(declarator, 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);

        // Skip if the value is a function type — those are already handled
        // by extractFunction via the functionTypes dispatch
        const value = getChildByField(declarator, 'value');
        if (value) {
          const valueType = value.type;
          if (
            this.extractor.functionTypes.includes(valueType)
          ) {
            continue; // Already handled by extractFunction
          }
        }

        const docstring = getPrecedingDocstring(exportNode, this.source);

        this.createNode('variable', name, declarator, {
          docstring,
          isExported: true,
        });
      }
    }
  }

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    const importText = getNodeText(node, this.source).trim();

    // Try language-specific hook first
    if (this.extractor.extractImport) {
      const info = this.extractor.extractImport(node, this.source);
      if (info) {
        this.createNode('import', info.moduleName, node, {
          signature: info.signature,
        });
        // Create unresolved reference unless the hook handled it
        if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: info.moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return;
      }
      // Hook returned null — fall through to multi-import inline handlers only
      // (hook returning null means "I didn't handle this" for multi-import cases,
      // NOT "use generic fallback" — the hook already declined)
    }

    if (this.extractPythonMultiImport(node, importText)) return;
    if (this.extractGoImports(node)) return;
    if (this.extractPhpGroupedImport(node, importText)) return;

    if (this.extractor.extractImport) return;

    this.createNode('import', importText, node, {
      signature: importText,
    });
  }

  private extractPythonMultiImport(node: SyntaxNode, importText: string): boolean {
    if (this.language !== 'python' || node.type !== 'import_statement') return false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'dotted_name') {
        this.createNode('import', getNodeText(child, this.source), node, { signature: importText });
      } else if (child?.type === 'aliased_import') {
        const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
        if (dottedName) {
          this.createNode('import', getNodeText(dottedName, this.source), node, { signature: importText });
        }
      }
    }
    return true;
  }

  private extractGoImports(node: SyntaxNode): boolean {
    if (this.language !== 'go') return false;
    const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
    const extractFromSpec = (spec: SyntaxNode): void => {
      const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
      if (stringLiteral) {
        const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
        if (importPath) {
          this.createNode('import', importPath, spec, {
            signature: getNodeText(spec, this.source).trim(),
          });
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: importPath,
              referenceKind: 'imports',
              line: spec.startPosition.row + 1,
              column: spec.startPosition.column,
            });
          }
        }
      }
    };
    const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
    if (importSpecList) {
      for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
        extractFromSpec(spec);
      }
    } else {
      const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
      if (importSpec) extractFromSpec(importSpec);
    }
    return true;
  }

  private extractPhpGroupedImport(node: SyntaxNode, importText: string): boolean {
    if (this.language !== 'php') return false;
    const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
    if (!namespacePrefix || !useGroup) return false;
    const prefix = getNodeText(namespacePrefix, this.source);
    const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
      c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
    );
    for (const clause of useClauses) {
      const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
      const name = nsName
        ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
        : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
      if (name) {
        const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
        this.createNode('import', fullPath, node, { signature: importText });
      }
    }
    return true;
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    const calleeName = this.resolveCalleeName(node);
    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  private resolveCalleeName(node: SyntaxNode): string {
    const nameField = getChildByField(node, 'name');
    const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');
    if (nameField && objectField &&
        (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
      return this.resolveNamedFieldCall(nameField, objectField);
    }
    const func = getChildByField(node, 'function') || node.namedChild(0);
    return func ? this.resolveFunctionFieldCall(func) : '';
  }

  private resolveNamedFieldCall(nameField: SyntaxNode, objectField: SyntaxNode): string {
    const methodName = getNodeText(nameField, this.source);
    if (!methodName) return '';
    const receiverName = getNodeText(objectField, this.source).replace(/^\$/, '');
    const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
    return SKIP_RECEIVERS.has(receiverName) ? methodName : `${receiverName}.${methodName}`;
  }

  private resolveFunctionFieldCall(func: SyntaxNode): string {
    if (func.type === 'member_expression' || func.type === 'attribute' ||
        func.type === 'selector_expression' || func.type === 'navigation_expression') {
      let property = getChildByField(func, 'property') || getChildByField(func, 'field');
      if (!property) {
        const child1 = func.namedChild(1);
        property = child1?.type === 'navigation_suffix'
          ? child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1
          : child1 ?? null;
      }
      if (!property) return '';
      const methodName = getNodeText(property, this.source);
      const receiver = getChildByField(func, 'object') || getChildByField(func, 'operand') || func.namedChild(0);
      const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
      if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier')) {
        const receiverName = getNodeText(receiver, this.source);
        return SKIP_RECEIVERS.has(receiverName) ? methodName : `${receiverName}.${methodName}`;
      }
      return methodName;
    }
    return getNodeText(func, this.source);
  }

  /**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // Extract structural nodes found inside function bodies.
      // Each extract method visits its own children, so we return after extracting.
      if (this.extractor!.classTypes.includes(nodeType)) {
        const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') this.extractStruct(node);
        else if (classification === 'enum') this.extractEnum(node);
        else if (classification === 'interface') this.extractInterface(node);
        else if (classification === 'trait') this.extractClass(node, 'trait');
        else this.extractClass(node);
        return;
      }
      if (this.extractor!.structTypes.includes(nodeType)) {
        this.extractStruct(node);
        return;
      }
      if (this.extractor!.enumTypes.includes(nodeType)) {
        this.extractEnum(node);
        return;
      }
      if (this.extractor!.interfaceTypes.includes(nodeType)) {
        this.extractInterface(node);
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  private extractInheritance(node: SyntaxNode, classId: string): void {
    const push: PushRef = ref => this.unresolvedReferences.push(ref);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (EXTENDS_CHILD_TYPES.has(child.type)) {
        inheritanceExtends(child, classId, this.source, push);
        continue;
      }
      if (IMPLEMENTS_CHILD_TYPES.has(child.type)) {
        inheritanceImplements(child, classId, this.source, push);
        continue;
      }

      if (child.type === 'argument_list' && node.type === 'class_definition') {
        for (const arg of child.namedChildren) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            push({ fromNodeId: classId, referenceName: getNodeText(arg, this.source), referenceKind: 'extends', line: arg.startPosition.row + 1, column: arg.startPosition.column });
          }
        }
        continue;
      }

      if ((child.type === 'identifier' || child.type === 'type_identifier') && node.type === 'class_heritage') {
        push({ fromNodeId: classId, referenceName: getNodeText(child, this.source), referenceKind: 'extends', line: child.startPosition.row + 1, column: child.startPosition.column });
        continue;
      }

      const handler = INHERITANCE_HANDLERS[child.type];
      if (handler) {
        handler(child, classId, this.source, push);
        continue;
      }

      if (CONTAINER_CHILD_TYPES.has(child.type)) {
        this.extractInheritance(child, classId);
      }
    }
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
  private extractRustImplItem(node: SyntaxNode): void {
    // Check if this is `impl Trait for Type` by looking for a `for` keyword
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // In `impl Trait for Type`, the type_identifiers are:
    // first = Trait name, last = implementing Type name
    // Also handle generic types like `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // Get the trait name (handle scoped paths like std::fmt::Display)
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
    }
  }

  /**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

  /**
   * Languages that support type annotations (TypeScript, etc.)
   */
  private readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp',
  ]);

  /**
   * Built-in/primitive type names that shouldn't create references
   */
  private readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
  ]);

  /**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Extract parameter type annotations
    const params = getChildByField(node, this.extractor.paramsField || 'parameters');
    if (params) {
      this.extractTypeRefsFromSubtree(params, nodeId);
    }

    // Extract return type annotation
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
    }

    // Extract direct type annotation (for class fields like `model: ITextModel`)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Extract type references from a variable's type annotation.
   */
  private extractVariableTypeAnnotation(node: SyntaxNode, nodeId: string): void {
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Find type_annotation child (covers TS `: Type`, Rust `: Type`, etc.)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Recursively walk a subtree and extract all type_identifier references.
   * Handles unions, intersections, generics, arrays, etc.
   */
  private extractTypeRefsFromSubtree(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'type_identifier') {
      const typeName = getNodeText(node, this.source);
      if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: typeName,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return; // type_identifier is a leaf
    }

    // Recurse into children (handles union_type, intersection_type, generic_type, etc.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.extractTypeRefsFromSubtree(child, fromNodeId);
      }
    }
  }

  /**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const handler = this.getPascalDispatch().get(node.type);
    return handler ? handler(node) : false;
  }

  private getPascalDispatch(): Map<string, (node: SyntaxNode) => boolean> {
    if (!this.pascalDispatch) this.pascalDispatch = this.buildPascalDispatch();
    return this.pascalDispatch;
  }

  private buildPascalDispatch(): Map<string, (node: SyntaxNode) => boolean> {
    const visitAll = (node: SyntaxNode): boolean => {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i); if (c) this.visitNode(c);
      }
      return true;
    };
    return new Map([
      ['unit', node => this.handlePascalModule(node)],
      ['program', node => this.handlePascalModule(node)],
      ['library', node => this.handlePascalModule(node)],
      ['declType', node => { this.extractPascalDeclType(node); return true; }],
      ['declUses', node => { this.extractPascalUses(node); return true; }],
      ['declConsts', node => {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i); if (c?.type === 'declConst') this.extractPascalConst(c);
        }
        return true;
      }],
      ['declConst', node => { this.extractPascalConst(node); return true; }],
      ['declTypes', visitAll],
      ['declVars', node => {
        for (let i = 0; i < node.namedChildCount; i++) {
          const c = node.namedChild(i);
          if (c?.type === 'declVar') {
            const nameNode = getChildByField(c, 'name');
            if (nameNode) this.createNode('variable', getNodeText(nameNode, this.source), c);
          }
        }
        return true;
      }],
      ['defProc', node => { this.extractPascalDefProc(node); return true; }],
      ['declProp', node => {
        const nameNode = getChildByField(node, 'name');
        if (nameNode) this.createNode('property', getNodeText(nameNode, this.source), node, { visibility: this.extractor!.getVisibility?.(node) });
        return true;
      }],
      ['declField', node => {
        const nameNode = getChildByField(node, 'name');
        if (nameNode) this.createNode('field', getNodeText(nameNode, this.source), node, { visibility: this.extractor!.getVisibility?.(node) });
        return true;
      }],
      ['declSection', visitAll],
      ['exprCall', node => { this.extractPascalCall(node); return true; }],
      ['interface', visitAll],
      ['implementation', visitAll],
      ['block', node => { this.visitPascalBlock(node); return true; }],
    ]);
  }

  private handlePascalModule(node: SyntaxNode): boolean {
    const moduleNameNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'moduleName');
    const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
    const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
    this.createNode('module', moduleName, node);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i); if (child) this.visitNode(child);
    }
    return true;
  }

  /**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // Find the inner type declaration
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      if (classNode) {
        // Extract inheritance from typeref children of declClass
        this.extractPascalInheritance(declClass, classNode.id);
        // Visit class body
        this.nodeStack.push(classNode.id);
        for (let i = 0; i < declClass.namedChildCount; i++) {
          const child = declClass.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      if (ifaceNode) {
        // Visit interface members
        this.nodeStack.push(ifaceNode.id);
        for (let i = 0; i < declIntf.namedChildCount; i++) {
          const child = declIntf.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (typeChild) {
      // Check if it contains a declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        if (enumNode) {
          // Extract enum members
          this.nodeStack.push(enumNode.id);
          for (let i = 0; i < declEnum.namedChildCount; i++) {
            const child = declEnum.namedChild(i);
            if (child?.type === 'declEnumValue') {
              const memberName = getChildByField(child, 'name');
              if (memberName) {
                this.createNode('enum_member', getNodeText(memberName, this.source), child);
              }
            }
          }
          this.nodeStack.pop();
        }
      } else {
        // Simple type alias: type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // Fallback: could be a forward declaration or simple alias
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * Extract Pascal uses clause into individual import nodes
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // Create unresolved reference for resolution
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a Pascal constant declaration
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // Find the matching declaration node by name to use as call parent
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName is like "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // Build method index on first use (O(n) once, then O(1) per lookup)
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::');
            if (qualifiedParts.length >= 2) {
              // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    const parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey) ||
      this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // Visit the block for calls
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * Extract function calls from a Pascal expression
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the callee name — first child is typically the identifier or exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // Also visit arguments for nested calls
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // Check if exprDot contains an exprCall
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}


