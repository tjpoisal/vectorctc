import { createHash } from "node:crypto";
import { Node, SyntaxKind, type ArrowFunction, type FunctionDeclaration, type FunctionExpression, type MethodDeclaration, type SourceFile } from "ts-morph";

export type FunctionLikeNode = FunctionDeclaration | ArrowFunction | MethodDeclaration | FunctionExpression;

export interface SubtreeFingerprint {
  exactHash: string;
  nodeCount: number;
  /** FNV-1a hashes of k-token windows. */
  shingles: Set<number>;
  /** One minimum hash per permutation. Length is the permutation count, not a band count. */
  minHashSignature: Uint32Array;
  tokens: string[];
}

const LARGE_PRIME = 4294967311;

function seeds(count: number): Array<{ a: number; b: number }> {
  return Array.from({ length: count }, (_, i) => ({
    a: ((i + 1) * 2654435761) >>> 0,
    b: ((i + 1) * 2246822519) >>> 0,
  }));
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isPunctuation(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstPunctuation && kind <= SyntaxKind.LastPunctuation;
}

export function isFunctionLike(node: Node): node is FunctionLikeNode {
  return Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isMethodDeclaration(node) || Node.isFunctionExpression(node);
}

function bindingNames(nameNode: Node): string[] {
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  if (Node.isObjectBindingPattern(nameNode) || Node.isArrayBindingPattern(nameNode)) {
    const names: string[] = [];
    for (const element of nameNode.getElements()) {
      if (Node.isBindingElement(element)) names.push(...bindingNames(element.getNameNode()));
    }
    return names;
  }
  return [];
}

function scopeMap(fn: FunctionLikeNode): Map<string, string> {
  const map = new Map<string, string>();
  let params = 0;
  let vars = 0;
  for (const param of fn.getParameters()) {
    for (const name of bindingNames(param.getNameNode())) {
      if (!map.has(name)) map.set(name, `$p${params++}`);
    }
  }
  const body = fn.getBody();
  if (!body) return map;
  const visit = (node: Node): void => {
    if (node !== body && isFunctionLike(node)) return;
    if (Node.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.getNameNode())) {
        if (!map.has(name)) map.set(name, `$v${vars++}`);
      }
    }
    node.forEachChild(visit);
  };
  visit(body);
  return map;
}

function collectScopes(root: FunctionLikeNode): Map<FunctionLikeNode, Map<string, string>> {
  const scopes = new Map<FunctionLikeNode, Map<string, string>>();
  const visit = (fn: FunctionLikeNode): void => {
    scopes.set(fn, scopeMap(fn));
    const body = fn.getBody();
    if (!body) return;
    body.forEachDescendant((node) => {
      if (isFunctionLike(node)) visit(node);
    });
  };
  visit(root);
  return scopes;
}

function lookup(stack: Map<string, string>[], name: string): string | undefined {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const hit = stack[i]?.get(name);
    if (hit) return hit;
  }
  return undefined;
}

function tokenFor(node: Node, stack: Map<string, string>[]): string {
  if (Node.isIdentifier(node)) {
    const text = node.getText();
    const renamed = lookup(stack, text);
    if (renamed) return `Id:${renamed}`;
    const parent = node.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return `Prop:${text}`;
    return `Ext:${text}`;
  }
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return "Lit:Str";
  if (Node.isNumericLiteral(node)) return `Lit:Num(${node.getText()})`;
  if (Node.isBigIntLiteral(node)) return "Lit:BigInt";
  if (Node.isBinaryExpression(node)) return `Bin:${node.getOperatorToken().getText()}`;
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
    return "KeepExpr";
  }
  return SyntaxKind[node.getKind()] ?? "Node";
}

function walk(node: Node, root: FunctionLikeNode, scopes: Map<FunctionLikeNode, Map<string, string>>, stack: Map<string, string>[], tokens: string[]): void {
  if (Node.isTypeNode(node) || Node.isTypeParameterDeclaration(node)) return;
  if (isFunctionLike(node) && node !== root) {
    tokens.push("NestedFn");
    const next = scopes.get(node);
    if (next) stack.push(next);
    const body = node.getBody();
    if (body) walk(body, root, scopes, stack, tokens);
    if (next) stack.pop();
    return;
  }
  if (!isPunctuation(node.getKind())) tokens.push(tokenFor(node, stack));
  if (Node.isIdentifier(node) || Node.isStringLiteral(node) || Node.isNumericLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return;
  }
  for (const child of node.getChildren()) {
    if (Node.isTypeNode(child)) continue;
    walk(child, root, scopes, stack, tokens);
  }
}

export function fingerprint(fn: FunctionLikeNode, shingleSize = 4, permutations = 64): SubtreeFingerprint {
  const body = fn.getBody();
  if (!body) {
    return { exactHash: "", nodeCount: 0, shingles: new Set(), minHashSignature: new Uint32Array(permutations), tokens: [] };
  }
  const scopes = collectScopes(fn);
  const rootScope = scopes.get(fn) ?? new Map<string, string>();
  const tokens: string[] = [];
  walk(body, fn, scopes, [rootScope], tokens);
  const shingles = new Set<number>();
  if (tokens.length >= shingleSize) {
    for (let i = 0; i <= tokens.length - shingleSize; i += 1) {
      shingles.add(fnv1a32(tokens.slice(i, i + shingleSize).join("|")));
    }
  } else if (tokens.length > 0) {
    shingles.add(fnv1a32(tokens.join("|")));
  }
  const exactHash = tokens.length === 0 ? "" : createHash("sha256").update(tokens.join(" ")).digest("hex").slice(0, 16);
  return {
    exactHash,
    nodeCount: tokens.length,
    shingles,
    minHashSignature: minHash(shingles, permutations),
    tokens,
  };
}

export function minHash(shingles: Set<number>, permutations: number): Uint32Array {
  const signature = new Uint32Array(permutations).fill(0xffffffff);
  const pairs = seeds(permutations);
  if (shingles.size === 0) return signature;
  for (const shingle of shingles) {
    for (let i = 0; i < permutations; i += 1) {
      const pair = pairs[i];
      if (!pair) continue;
      const permuted = Number((BigInt(pair.a) * BigInt(shingle) + BigInt(pair.b)) % BigInt(LARGE_PRIME));
      const current = signature[i] ?? 0xffffffff;
      if (permuted < current) signature[i] = permuted;
    }
  }
  return signature;
}

export function jaccardSimilarity(left: Set<number>, right: Set<number>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const shingle of smaller) {
    if (larger.has(shingle)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Fraction of permutations that agree. A filter, not an upper bound. */
export function minHashAgreement(left: Uint32Array, right: Uint32Array): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < length; i += 1) {
    if (left[i] === right[i]) matches += 1;
  }
  return matches / length;
}

export function functionsIn(sourceFile: SourceFile): FunctionLikeNode[] {
  return [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];
}

export function functionName(fn: FunctionLikeNode): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? "<anonymous>";
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getName();
  return "<anonymous>";
}
