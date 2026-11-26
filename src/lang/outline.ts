import { parseSync, walk, type GrammarId, type SyntaxNode } from "./treesitter.js";

/** A language-neutral outline of one Python or Go file: what the language-agnostic rules need. */
export interface ImportRef {
  /** Python dotted module ("a.b"), or Go import path ("github.com/x/y"). */
  module: string;
  /** Leading dots of a Python relative import (0 = absolute). */
  dots: number;
  /** Names pulled in by `from m import a, b` ("*" for a wildcard). */
  names: string[];
  /** Local binding for the module itself (Python `import a.b as c` → c; `import a.b` → a; Go package name / alias). */
  local: string | null;
  line: number;
}

export interface FunctionInfo {
  name: string;
  /** Class.method (Python) or Receiver.Method (Go). */
  qualified: string;
  start: number;
  end: number;
  complexity: number;
  /** Source text of the function. */
  text: string;
  /** Simple names this function calls. */
  calls: string[];
}

export interface Outline {
  language: GrammarId;
  parser: "tree-sitter" | "fallback";
  imports: ImportRef[];
  functions: FunctionInfo[];
  /** Names defined at module / package top level. */
  topLevel: Set<string>;
  /** `object.attribute` references (line, object, attribute). */
  attributes: Array<{ line: number; object: string; attribute: string }>;
  /** Go package clause name. */
  packageName: string | null;
}

const cache = new Map<string, Outline>();

export function outline(language: GrammarId, text: string): Outline {
  const key = `${language}\u0000${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const tree = parseSync(language, text);
  const result = tree ? (language === "python" ? pythonTree(tree.rootNode, text) : goTree(tree.rootNode, text)) : language === "python" ? pythonFallback(text) : goFallback(text);
  tree?.delete();
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

const line = (node: SyntaxNode): number => node.startPosition.row + 1;
const endLine = (node: SyntaxNode): number => node.endPosition.row + 1;

function countDescendants(node: SyntaxNode, test: (node: SyntaxNode) => boolean, stopAt: Set<string>): number {
  let count = 0;
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (stopAt.has(child.type)) continue;
    if (test(child)) count += 1;
    count += countDescendants(child, test, stopAt);
  }
  return count;
}

function callNames(node: SyntaxNode, callType: string, fnField: string, stopAt: Set<string>): string[] {
  const out = new Set<string>();
  const visit = (current: SyntaxNode): void => {
    for (const child of current.namedChildren) {
      if (!child || stopAt.has(child.type)) continue;
      if (child.type === callType) {
        const fn = child.childForFieldName(fnField);
        if (fn) {
          const text = fn.text;
          const simple = text.split(".").pop() ?? text;
          if (/^\w+$/.test(simple)) out.add(simple);
        }
      }
      visit(child);
    }
  };
  visit(node);
  return [...out];
}

// ---------------------------------------------------------------- Python

const PY_DECISIONS = new Set(["if_statement", "elif_clause", "for_statement", "while_statement", "except_clause", "conditional_expression", "boolean_operator", "case_clause", "if_clause", "for_in_clause"]);
const PY_FUNCTIONS = new Set(["function_definition", "lambda"]);

function pythonTree(root: SyntaxNode, text: string): Outline {
  const out: Outline = { language: "python", parser: "tree-sitter", imports: [], functions: [], topLevel: new Set(), attributes: [], packageName: null };
  walk(root, (node) => {
    if (node.type === "import_statement") {
      for (const child of node.namedChildren) {
        if (!child) continue;
        const nameNode = child.type === "aliased_import" ? child.childForFieldName("name") : child;
        const alias = child.type === "aliased_import" ? child.childForFieldName("alias")?.text ?? null : null;
        if (!nameNode) continue;
        out.imports.push({ module: nameNode.text, dots: 0, names: [], local: alias ?? nameNode.text.split(".")[0] ?? null, line: line(node) });
      }
      return false;
    }
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      let module = moduleNode?.text ?? "";
      let dots = 0;
      if (moduleNode?.type === "relative_import") {
        const match = module.match(/^(\.+)(.*)$/);
        dots = match?.[1]?.length ?? 0;
        module = match?.[2] ?? "";
      }
      const names: string[] = [];
      for (const child of node.namedChildren) {
        if (!child || child === moduleNode || child.id === moduleNode?.id) continue;
        if (child.type === "wildcard_import") names.push("*");
        else if (child.type === "dotted_name") names.push(child.text);
        else if (child.type === "aliased_import") names.push(child.childForFieldName("name")?.text ?? child.text);
      }
      out.imports.push({ module, dots, names, local: null, line: line(node) });
      return false;
    }
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      let owner: string | null = null;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === "class_definition") {
          owner = parent.childForFieldName("name")?.text ?? null;
          break;
        }
        if (parent.type === "function_definition") break;
      }
      out.functions.push({
        name,
        qualified: owner ? `${owner}.${name}` : name,
        start: line(node),
        end: endLine(node),
        complexity: 1 + countDescendants(node, (child) => PY_DECISIONS.has(child.type), PY_FUNCTIONS),
        text: node.text,
        calls: callNames(node, "call", "function", PY_FUNCTIONS),
      });
    }
    if (node.type === "attribute") {
      const object = node.childForFieldName("object");
      const attribute = node.childForFieldName("attribute");
      if (object?.type === "identifier" && attribute) out.attributes.push({ line: line(node), object: object.text, attribute: attribute.text });
    }
    return true;
  });
  const top = (nodes: Array<SyntaxNode | null>): void => {
    for (const node of nodes) {
      if (!node) continue;
      if (node.type === "function_definition" || node.type === "class_definition") {
        const name = node.childForFieldName("name")?.text;
        if (name) out.topLevel.add(name);
      } else if (node.type === "decorated_definition") {
        top([node.childForFieldName("definition")]);
      } else if (node.type === "expression_statement") {
        for (const child of node.namedChildren) {
          if (child?.type !== "assignment" && child?.type !== "augmented_assignment") continue;
          const left = child.childForFieldName("left");
          if (!left) continue;
          if (left.type === "identifier") out.topLevel.add(left.text);
          else for (const id of left.descendantsOfType("identifier")) if (id) out.topLevel.add(id.text);
        }
      } else if (node.type === "if_statement" || node.type === "try_statement" || node.type === "block" || node.type === "else_clause" || node.type === "except_clause" || node.type === "finally_clause" || node.type === "with_statement" || node.type === "elif_clause") {
        top(node.namedChildren);
      }
    }
  };
  top(root.namedChildren);
  for (const item of out.imports) {
    if (item.names.length === 0 && item.local) out.topLevel.add(item.local);
    for (const name of item.names) if (name !== "*") out.topLevel.add(name.split(".").pop() ?? name);
  }
  void text;
  return out;
}

function pythonFallback(text: string): Outline {
  const out: Outline = { language: "python", parser: "fallback", imports: [], functions: [], topLevel: new Set(), attributes: [], packageName: null };
  const lines = text.split("\n");
  const indent = (value: string): number => value.length - value.trimStart().length;
  const classStack: Array<{ name: string; indent: number }> = [];
  lines.forEach((raw, index) => {
    const code = raw.replace(/(^|\s)#.*$/, "$1");
    if (!code.trim()) return;
    const level = indent(code);
    while (classStack.length > 0 && (classStack[classStack.length - 1]?.indent ?? 0) >= level) classStack.pop();
    const from = code.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+\(?([^)]*)\)?/);
    if (from) {
      const names = (from[3] ?? "").split(",").map((item) => item.trim().split(/\s+as\s+/)[0] ?? "").filter((item) => /^[\w.*]+$/.test(item));
      out.imports.push({ module: from[2] ?? "", dots: from[1]?.length ?? 0, names, local: null, line: index + 1 });
      if (level === 0) for (const name of names) if (name !== "*") out.topLevel.add(name);
      return;
    }
    const plain = code.match(/^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)/);
    if (plain) {
      for (const part of (plain[1] ?? "").split(",")) {
        const [module = "", alias] = part.trim().split(/\s+as\s+/);
        const local = alias ?? module.split(".")[0] ?? null;
        out.imports.push({ module, dots: 0, names: [], local, line: index + 1 });
        if (level === 0 && local) out.topLevel.add(local);
      }
      return;
    }
    const cls = code.match(/^(\s*)class\s+(\w+)/);
    if (cls) {
      if (level === 0) out.topLevel.add(cls[2] ?? "");
      classStack.push({ name: cls[2] ?? "", indent: level });
      return;
    }
    const def = code.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (def) {
      let end = index + 1;
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next] ?? "";
        if (candidate.trim() && !candidate.trim().startsWith("#") && indent(candidate) <= level) break;
        if (candidate.trim()) end = next + 1;
      }
      const body = lines.slice(index, end).join("\n");
      const owner = classStack[classStack.length - 1]?.name;
      const name = def[2] ?? "(anonymous)";
      out.functions.push({
        name,
        qualified: owner ? `${owner}.${name}` : name,
        start: index + 1,
        end,
        complexity: 1 + (body.replace(/#.*$/gm, "").match(/\b(if|elif|for|while|except|and|or|case)\b/g)?.length ?? 0),
        text: body,
        calls: [...new Set([...body.matchAll(/\b(\w+)\s*\(/g)].map((match) => match[1] ?? "").filter((name) => !/^(if|while|for|def|return|print|elif|and|or|not)$/.test(name)))],
      });
      if (level === 0) out.topLevel.add(name);
      return;
    }
    const assign = code.match(/^(\w+)\s*(?::[^=]+)?=(?!=)/);
    if (assign && level === 0) out.topLevel.add(assign[1] ?? "");
    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) out.attributes.push({ line: index + 1, object: match[1] ?? "", attribute: match[2] ?? "" });
  });
  return out;
}

// ---------------------------------------------------------------- Go

const GO_DECISIONS = new Set(["if_statement", "for_statement", "expression_case", "type_case", "communication_case"]);
const GO_FUNCTIONS = new Set(["func_literal"]);

function goTree(root: SyntaxNode, text: string): Outline {
  const out: Outline = { language: "go", parser: "tree-sitter", imports: [], functions: [], topLevel: new Set(), attributes: [], packageName: null };
  for (const node of root.namedChildren) {
    if (!node) continue;
    if (node.type === "package_clause") out.packageName = node.namedChildren[0]?.text ?? null;
    if (node.type === "import_declaration") {
      for (const spec of node.descendantsOfType("import_spec")) {
        if (!spec) continue;
        const pathText = (spec.childForFieldName("path")?.text ?? "").replace(/^["`]|["`]$/g, "");
        const alias = spec.childForFieldName("name")?.text ?? null;
        out.imports.push({ module: pathText, dots: 0, names: [], local: alias ?? pathText.split("/").pop() ?? null, line: line(spec) });
      }
    }
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text ?? "(anonymous)";
      let receiver: string | null = null;
      if (node.type === "method_declaration") {
        const typeId = node.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0];
        receiver = typeId?.text ?? null;
      } else out.topLevel.add(name);
      const binaries = node.descendantsOfType("binary_expression").filter((item) => {
        const operator = item?.childForFieldName("operator")?.text;
        return operator === "&&" || operator === "||";
      }).length;
      out.functions.push({
        name,
        qualified: receiver ? `${receiver}.${name}` : name,
        start: line(node),
        end: endLine(node),
        complexity: 1 + countDescendants(node, (child) => GO_DECISIONS.has(child.type), GO_FUNCTIONS) + binaries,
        text: node.text,
        calls: callNames(node, "call_expression", "function", GO_FUNCTIONS),
      });
    }
    if (node.type === "type_declaration" || node.type === "const_declaration" || node.type === "var_declaration") {
      for (const spec of node.namedChildren) {
        if (!spec) continue;
        const specs = spec.type.endsWith("_spec_list") ? spec.namedChildren : [spec];
        for (const item of specs) {
          if (!item) continue;
          const names = item.childrenForFieldName("name");
          for (const name of names) if (name) out.topLevel.add(name.text);
        }
      }
    }
  }
  walk(root, (node) => {
    if (node.type === "selector_expression" || node.type === "qualified_type") {
      const object = node.type === "selector_expression" ? node.childForFieldName("operand") : node.childForFieldName("package");
      const attribute = node.type === "selector_expression" ? node.childForFieldName("field") : node.childForFieldName("name");
      if (object && (object.type === "identifier" || object.type === "package_identifier") && attribute) out.attributes.push({ line: line(node), object: object.text, attribute: attribute.text });
    }
    return true;
  });
  void text;
  return out;
}

function goFallback(text: string): Outline {
  const out: Outline = { language: "go", parser: "fallback", imports: [], functions: [], topLevel: new Set(), attributes: [], packageName: null };
  const lines = text.split("\n");
  let inImport = false;
  let block: "type" | "const" | "var" | null = null;
  lines.forEach((raw, index) => {
    const code = raw.replace(/(^|[^:"`])\/\/.*$/, "$1");
    const pkg = code.match(/^package\s+(\w+)/);
    if (pkg) out.packageName = pkg[1] ?? null;
    const addImport = (alias: string | undefined, spec: string): void => {
      out.imports.push({ module: spec, dots: 0, names: [], local: alias ?? spec.split("/").pop() ?? null, line: index + 1 });
    };
    if (/^import\s*\($/.test(code.trim())) {
      inImport = true;
      return;
    }
    if (inImport) {
      if (code.trim() === ")") inImport = false;
      const spec = code.match(/^\s*([\w.]+\s+)?"([^"]+)"/);
      if (spec) addImport(spec[1]?.trim(), spec[2] ?? "");
      return;
    }
    const single = code.match(/^import\s+([\w.]+\s+)?"([^"]+)"/);
    if (single) addImport(single[1]?.trim(), single[2] ?? "");
    const blockStart = code.match(/^(type|const|var)\s*\($/);
    if (blockStart) {
      block = blockStart[1] as "type" | "const" | "var";
      return;
    }
    if (block) {
      if (code.trim() === ")") block = null;
      else {
        const name = code.match(/^\s*(\w+)/);
        if (name) out.topLevel.add(name[1] ?? "");
      }
      return;
    }
    const decl = code.match(/^(?:type|const|var)\s+(\w+)/);
    if (decl) out.topLevel.add(decl[1] ?? "");
    const fn = code.match(/^func\s+(\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*)?(\w+)/);
    if (fn) {
      let depth = 0;
      let end = index + 1;
      let opened = false;
      for (let next = index; next < lines.length; next += 1) {
        const candidate = (lines[next] ?? "").replace(/"(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*'/g, "\"\"");
        for (const char of candidate) {
          if (char === "{") {
            depth += 1;
            opened = true;
          } else if (char === "}") depth -= 1;
        }
        end = next + 1;
        if (opened && depth <= 0) break;
      }
      const body = lines.slice(index, end).join("\n");
      const name = fn[3] ?? "(anonymous)";
      if (!fn[1]) out.topLevel.add(name);
      out.functions.push({
        name,
        qualified: fn[2] ? `${fn[2]}.${name}` : name,
        start: index + 1,
        end,
        complexity: 1 + (body.replace(/\/\/.*$/gm, "").match(/\b(if|for|case)\b|&&|\|\|/g)?.length ?? 0),
        text: body,
        calls: [...new Set([...body.matchAll(/\b(\w+)\s*\(/g)].map((match) => match[1] ?? "").filter((name) => !/^(if|for|func|return|switch)$/.test(name)))],
      });
    }
    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) out.attributes.push({ line: index + 1, object: match[1] ?? "", attribute: match[2] ?? "" });
  });
  return out;
}
