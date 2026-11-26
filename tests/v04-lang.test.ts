import { beforeAll, describe, expect, it } from "vitest";

import { applyWrite, applyWriteReviewed } from "../src/gate/apply.js";
import { polyglotViolations } from "../src/lang/polyglot.js";
import { outline } from "../src/lang/outline.js";
import { ensureGrammar, grammarLoaded } from "../src/lang/treesitter.js";
import { effectivePolicy } from "../src/policy/policy.js";
import { plan, repo } from "./v04-helpers.js";

process.env.CTC_ORG_POLICY = "/nonexistent/ctc-org-policy.json";
process.env.CTC_FINDINGS_LOG = "off";

const PY_UTIL = `import re


def slugify(title):
    text = title.strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    if not text:
        return "untitled"
    return text[:64]


class Invoice:
    def total(self, lines):
        return sum(line.amount for line in lines)
`;

const GO_UTIL = `package util

import "strings"

// Slugify turns a title into a URL slug.
func Slugify(title string) string {
	text := strings.ToLower(strings.TrimSpace(title))
	text = strings.ReplaceAll(text, " ", "-")
	if text == "" {
		return "untitled"
	}
	return text
}
`;

function check(root: string, relativePath: string, before: string | null, after: string, extra = {}) {
  return polyglotViolations({ root, relativePath, before, after, plan: plan({ allowedFileGlobs: ["**"], ...extra }), policy: effectivePolicy(root, relativePath) });
}

describe.each([["tree-sitter", true], ["line-based fallback", false]])("Python + Go rules (%s)", (_label, useTreeSitter) => {
  beforeAll(async () => {
    if (useTreeSitter) {
      expect(await ensureGrammar("python")).toBe(true);
      expect(await ensureGrammar("go")).toBe(true);
    }
  });
  const parserFor = (language: "python" | "go") => (useTreeSitter ? (grammarLoaded(language) ? "tree-sitter" : "fallback") : "fallback");

  it("outlines imports, functions, complexity and top-level names", () => {
    if (!useTreeSitter && grammarLoaded("python")) return; // fallback is exercised directly below
    const py = outline("python", PY_UTIL);
    expect(py.parser).toBe(parserFor("python"));
    expect(py.imports.map((item) => item.module)).toEqual(["re"]);
    expect(py.functions.map((fn) => fn.qualified)).toEqual(["slugify", "Invoice.total"]);
    expect(py.functions[0]?.complexity).toBe(2);
    expect([...py.topLevel]).toEqual(expect.arrayContaining(["slugify", "Invoice", "re"]));
    const go = outline("go", GO_UTIL);
    expect(go.packageName).toBe("util");
    expect(go.functions[0]?.qualified).toBe("Slugify");
    expect(go.functions[0]?.complexity).toBe(2);
  });
});

describe("Python rules", () => {
  beforeAll(async () => {
    await ensureGrammar("python");
  });

  it("holds phantom modules and symbols, accepts stdlib, local and declared imports", () => {
    const root = repo({ "app/__init__.py": "", "app/util.py": PY_UTIL, "requirements.txt": "requests==2.31.0\nPyYAML>=6\n" }, { tsconfig: false });
    const after = `import os
import requests
import yaml
from app.util import slugify
from app.util import slugifyTitle
from app.helpers import thing
import flask
from . import util
from .util import Invoice
import app.util as u

def handler(title):
    return u.slugify(title) + u.missing_fn(title)
`;
    const found = check(root, "app/views.py", null, after);
    const codes = found.map((item) => `${item.code}@${item.line}`);
    expect(codes).toEqual(["PHANTOM_SYMBOL@5", "PHANTOM_IMPORT@6", "PHANTOM_IMPORT@7", "PHANTOM_SYMBOL@13"]);
    expect(found[0]?.message).toContain("app/util.py");
    expect(found[0]?.fix).toContain("did you mean 'slugify'");
    expect(found[2]?.message).toContain("requirements.txt");
    expect(found[2]?.severity).toBeUndefined();
  });

  it("downgrades unknown third-party imports to warnings when no manifest exists", () => {
    const root = repo({ "tool.py": "print('hi')\n" }, { tsconfig: false });
    const found = check(root, "tool.py", "print('hi')\n", "import flask\nprint('hi')\n");
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warn");
  });

  it("flags a re-implemented helper and stays quiet for unrelated code", () => {
    const root = repo({ "app/__init__.py": "", "app/util.py": PY_UTIL, "requirements.txt": "" }, { tsconfig: false });
    const copy = `import re


def make_slug(name):
    value = name.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = value.strip("-")
    if not value:
        return "untitled"
    return value[:64]
`;
    const dup = check(root, "app/posts.py", null, copy);
    expect(dup.map((item) => item.code)).toEqual(["DUPLICATE_LOGIC"]);
    expect(dup[0]?.message).toContain("'slugify' in app/util.py:4");
    const fresh = `def area(width, height):
    if width <= 0 or height <= 0:
        raise ValueError("bad size")
    result = width * height
    print(result)
    return result
`;
    expect(check(root, "app/geometry.py", null, fresh)).toEqual([]);
  });

  it("is diff-aware for complexity and enforces allowedEditSymbols with derived callees", () => {
    const root = repo({ "requirements.txt": "" }, { tsconfig: false });
    const branches = Array.from({ length: 11 }, (_, index) => `    if x == ${index}:\n        return ${index}`).join("\n");
    const complex = `def pick(x):\n${branches}\n    return -1\n`;
    const held = check(root, "rules.py", null, complex);
    expect(held.map((item) => item.code)).toEqual(["COMPLEXITY"]);
    // Touching an already-complex function without making it worse is not a new finding.
    expect(check(root, "rules.py", complex, complex.replace("return -1", "return -2"))).toEqual([]);

    const before = `def helper(x):\n    return x + 1\n\n\ndef target(x):\n    return x\n\n\ndef other(x):\n    return x\n`;
    const scoped = before.replace("def target(x):\n    return x", "def target(x):\n    return helper(x)").replace("def helper(x):\n    return x + 1", "def helper(x):\n    return x + 2").replace("def other(x):\n    return x", "def other(x):\n    return x * 3");
    const scope = check(root, "rules.py", before, scoped, { allowedEditSymbols: ["target"] });
    expect(scope.map((item) => `${item.code}:${item.message.match(/'(\w+)'/)?.[1]}`)).toEqual(["EDIT_OUTSIDE_PLAN_SCOPE:other"]);
  });

  it("runs through the full write gate", async () => {
    const root = repo({ "app/__init__.py": "", "app/util.py": PY_UTIL, "requirements.txt": "", ".ctc/flight-plan.json": JSON.stringify(plan({ allowedFileGlobs: ["app/**"] })) }, { tsconfig: false });
    const result = await applyWriteReviewed(root, { path: "app/views.py", content: "from app.util import slugifyTitle\n", plan: plan({ allowedFileGlobs: ["app/**"] }) });
    expect(result.written).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain("PHANTOM_SYMBOL");
    const ok = applyWrite(root, { path: "app/views.py", content: "from app.util import slugify\n\nprint(slugify('A b'))\n", plan: plan({ allowedFileGlobs: ["app/**"] }) });
    expect(ok.written).toBe(true);
  });
});

describe("Go rules", () => {
  beforeAll(async () => {
    await ensureGrammar("go");
  });

  const GO_MOD = "module example.com/shop\n\ngo 1.22\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n)\n";

  it("holds phantom packages, unrequired modules and missing exported identifiers", () => {
    const root = repo({ "go.mod": GO_MOD, "internal/util/slug.go": GO_UTIL }, { tsconfig: false });
    const after = `package main

import (
	"fmt"
	"strings/textutil"
	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
	"example.com/shop/internal/util"
	"example.com/shop/internal/money"
)

func main() {
	fmt.Println(util.Slugify("A b"), util.MakeSlug("x"), uuid.NewString(), strings.ToLower("x"))
}
`;
    const found = check(root, "cmd/main.go", null, after);
    expect(found.map((item) => `${item.code}@${item.line}`)).toEqual(["PHANTOM_IMPORT@5", "PHANTOM_IMPORT@7", "PHANTOM_IMPORT@9", "PHANTOM_SYMBOL@13"]);
    expect(found[1]?.message).toContain("not required in go.mod");
    expect(found[3]?.message).toContain("exports no 'MakeSlug'");
  });

  it("flags duplicated Go logic", () => {
    const root = repo({ "go.mod": GO_MOD, "internal/util/slug.go": GO_UTIL }, { tsconfig: false });
    const copy = `package handlers

import "strings"

func slugFor(name string) string {
	value := strings.ToLower(strings.TrimSpace(name))
	value = strings.ReplaceAll(value, " ", "-")
	if value == "" {
		return "untitled"
	}
	return value
}
`;
    expect(check(root, "internal/handlers/post.go", null, copy).map((item) => item.code)).toEqual(["DUPLICATE_LOGIC"]);
  });
});
