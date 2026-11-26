import { fingerprint, functionName, functionsIn } from "../hash/ast-hasher.js";
import { moduleSpecifier, utilityIndexFor } from "../hash/utility-index.js";
import { violation, type Rule } from "../types.js";

export const duplicateRule: Rule = {
  id: "duplicates",
  gate: "ast",
  order: 90,
  check(ctx) {
    const settings = ctx.config.rules.duplicates;
    if (!settings.enabled || !ctx.sourceFile) return [];
    const index = utilityIndexFor(ctx.root, settings.utilityGlobs, {
      minNodeCount: settings.minAstNodes,
      shingleSize: settings.shingleSize,
      permutations: settings.minHashPermutations,
      warnThreshold: settings.duplicateWarnThreshold,
    });
    const violations = [];
    for (const fn of functionsIn(ctx.sourceFile)) {
      const printed = fingerprint(fn, settings.shingleSize, settings.minHashPermutations);
      if (!printed.exactHash || printed.nodeCount < settings.minAstNodes) continue;
      const name = functionName(fn);
      const match = index.findSimilar(printed, name, ctx.relativePath);
      if (!match) continue;
      const specifier = moduleSpecifier(match.utility.filePath);
      const block = match.similarity >= settings.duplicateBlockThreshold;
      violations.push(
        violation({
          code: "DUPLICATE_LOGIC",
          rule: "duplicates",
          gate: "ast",
          file: ctx.relativePath,
          line: fn.getStartLineNumber(),
          column: 1,
          severity: block ? "block" : "warn",
          similarity: Number(match.similarity.toFixed(3)),
          message:
            match.matchType === "EXACT"
              ? `Reinvented utility: '${name}' matches exported '${match.utility.symbolName}'.`
              : `Near-duplicate utility: '${name}' is similar to '${match.utility.symbolName}' (${match.similarity.toFixed(2)}).`,
          fix: `Delete '${name}' and import { ${match.utility.symbolName} } from "${specifier}".`,
          useInstead: `import { ${match.utility.symbolName} } from "${specifier}"`,
        }),
      );
    }
    return violations;
  },
};
