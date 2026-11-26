import { ts } from "ts-morph";

/** One callable in a file: a top-level function, a `const f = (…) => …` / function expression, or a class method. */
export interface Callable {
  /** "fn", "Class.method" or "Class.static.method". */
  key: string;
  name: string;
  ref: string[];
  exported: boolean;
  async: boolean;
  generator: boolean;
  params: ParamInfo[];
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Line of the declaration head (where findings are reported). */
  line: number;
  /** Body text with whitespace collapsed (cheap "did it change" test). */
  bodyText: string;
  /** Number of top-level statements in the body (an expression body counts as 1). */
  statements: number;
  /** Identifiers the function reads that it does not declare. */
  freeIdentifiers: Set<string>;
  /** True when the body is a single call to another named function (reuse, not a copy). */
  delegation: boolean;
}

export interface ParamInfo {
  name: string;
  /** Declared type text, the constraint of a generic, or the type inferred from a literal initializer; null if unknown. */
  type: string | null;
  optional: boolean;
  rest: boolean;
}

export interface FileModel {
  callables: Callable[];
  /** Top-level binding names, for the sandbox registry. */
  names: string[];
  /** Identifiers bound at the top level of the file (imports included). */
  topLevel: Set<string>;
  imported: Set<string>;
  parseErrors: boolean;
}

const cache = new Map<string, FileModel>();

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);
}

function initializerType(init: ts.Expression | undefined): string | null {
  if (!init) return null;
  if (ts.isStringLiteralLike(init) || ts.isTemplateExpression(init)) return "string";
  if (ts.isNumericLiteral(init) || (ts.isPrefixUnaryExpression(init) && ts.isNumericLiteral(init.operand))) return "number";
  if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword) return "boolean";
  if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "Date") return "Date";
  return null;
}

function paramsOf(fn: ts.SignatureDeclaration, sf: ts.SourceFile): ParamInfo[] {
  const generics = new Map<string, string | null>();
  for (const tp of fn.typeParameters ?? []) generics.set(tp.name.text, tp.constraint ? tp.constraint.getText(sf) : null);
  return fn.parameters.map((p) => {
    let type = p.type ? p.type.getText(sf) : initializerType(p.initializer);
    if (type && generics.has(type)) type = generics.get(type) ?? null;
    return {
      name: ts.isIdentifier(p.name) ? p.name.text : "_",
      type,
      optional: Boolean(p.questionToken || p.initializer),
      rest: Boolean(p.dotDotDotToken),
    };
  });
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Free identifiers: every identifier in value position that no declaration inside the function binds. */
function freeIdentifiersOf(fn: ts.Node): Set<string> {
  const declared = new Set<string>();
  const used = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) bindingNames(node.name, declared);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name) declared.add(node.name.text);
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isProperty = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isMethodDeclaration(parent) && parent.name === node) || ts.isTypeReferenceNode(parent));
      if (!isProperty) used.add(node.text);
      if (parent && ts.isShorthandPropertyAssignment(parent)) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  for (const name of declared) used.delete(name);
  used.delete("undefined");
  used.delete("this");
  return used;
}

function isDelegation(body: ts.ConciseBody | undefined): boolean {
  if (!body) return false;
  let expr: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return false;
    const only = body.statements[0];
    if (only && ts.isReturnStatement(only)) expr = only.expression;
    else if (only && ts.isExpressionStatement(only)) expr = only.expression;
  } else expr = body;
  while (expr && (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr))) expr = expr.expression;
  return Boolean(expr && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression));
}

function callableOf(
  sf: ts.SourceFile,
  node: ts.FunctionLikeDeclaration,
  head: ts.Node,
  name: string,
  ref: string[],
  exported: boolean,
): Callable | null {
  const body = node.body;
  if (!body) return null;
  return {
    key: ref.join("."),
    name,
    ref,
    exported,
    async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
    generator: Boolean(node.asteriskToken),
    params: paramsOf(node, sf),
    startLine: lineOf(sf, head.getStart(sf)),
    endLine: lineOf(sf, head.getEnd()),
    line: lineOf(sf, node.getStart(sf)),
    bodyText: body.getText(sf).replace(/\s+/g, " "),
    statements: ts.isBlock(body) ? body.statements.length : 1,
    freeIdentifiers: freeIdentifiersOf(node),
    delegation: isDelegation(body),
  };
}

export function modelOf(fileName: string, text: string): FileModel {
  const cacheKey = `${fileName}\u0000${text}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const kind = /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, kind);
  const callables: Callable[] = [];
  const names: string[] = [];
  const topLevel = new Set<string>();
  const imported = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) imported.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imported.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) imported.add(el.name.text);
      continue;
    }
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      if (!names.includes(name)) names.push(name);
      topLevel.add(name);
      if (!statement.body) continue;
      const c = callableOf(sf, statement, statement, name, [name], exported);
      if (c) callables.push(c);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const bound = new Set<string>();
        bindingNames(decl.name, bound);
        for (const n of bound) {
          topLevel.add(n);
          names.push(n);
        }
        const init = decl.initializer;
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const c = callableOf(sf, init, statement, decl.name.text, [decl.name.text], exported);
          if (c) {
            // `const f: typeof g = function (p) {}` keeps the typed signature on the variable; untyped params stay unknown.
            callables.push(c);
          }
        }
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const cls = statement.name.text;
      names.push(cls);
      topLevel.add(cls);
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
        const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
        const method = member.name.text;
        const ref = isStatic ? [cls, "static", method] : [cls, method];
        const c = callableOf(sf, member, member, `${cls}.${method}`, ref, exported);
        if (c) callables.push(c);
      }
    } else if (ts.isEnumDeclaration(statement)) {
      names.push(statement.name.text);
      topLevel.add(statement.name.text);
    }
  }
  const parseErrors = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0;
  const model: FileModel = { callables, names: [...new Set(names)], topLevel, imported, parseErrors };
  if (cache.size > 200) cache.clear();
  cache.set(cacheKey, model);
  return model;
}

const jsCache = new Map<string, string>();

/** CommonJS JavaScript for the sandbox; type-only constructs are erased, imports become stubbed require() calls. */
export function toSandboxJs(fileName: string, text: string): string {
  const key = `${fileName}\u0000${text}`;
  const hit = jsCache.get(key);
  if (hit !== undefined) return hit;
  const out = ts.transpileModule(text, {
    fileName: fileName.replace(/\.[cm]?jsx?$/, ".ts"),
    reportDiagnostics: false,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      esModuleInterop: false,
      importHelpers: false,
      sourceMap: false,
      removeComments: true,
      verbatimModuleSyntax: false,
      isolatedModules: true,
    },
  }).outputText;
  if (jsCache.size > 200) jsCache.clear();
  jsCache.set(key, out);
  return out;
}
