import fs from "node:fs";
import path from "node:path";

export const INSTRUCTION = `# Code Traffic Control

Route every write through CTC. The blueprint flight plan and RunwayGateAnalyzer are the source of truth.

1. Prefer the MCP tools \`ctc_write_file\`, \`ctc_patch_file\`, and \`ctc_read_file\` after \`ctc_onboard_idea\` and \`ctc_promote_task_to_flight_plan\`.
2. From any shell: \`ctc check <file> --content-from stdin\` then \`ctc apply <file> --content-from stdin\`. Exit 0 is a pass, 2 is a hold, 1 is an error. \`--json\` prints \`ctc.hold.v1\`.
3. On localhost: POST /v1/check, /v1/write, /v1/patch, and /v1/read. GET /openapi.json is an OpenAPI 3.1 document. Function-calling models can import \`ctc export-tools --format openai|anthropic|gemini|json-schema\`.
4. A hold means the bytes were not accepted. Fix every violation and submit the full file again. Do not bypass CTC with a native write tool.
5. If a tool cannot call CTC, the git pre-commit hook still rejects the change. Do not skip hooks.
`;

function upsert(file: string, heading: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const marker = `<!-- ${heading} -->`;
  const block = `${marker}\n${body.trim()}\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${block}\n`, "utf8");
    return;
  }
  const current = fs.readFileSync(file, "utf8");
  if (current.includes(marker)) {
    const pattern = new RegExp(`${marker}[\\s\\S]*?(?=\\n<!-- |$)`);
    fs.writeFileSync(file, current.replace(pattern, block.trimEnd()), "utf8");
    return;
  }
  fs.writeFileSync(file, `${current.trimEnd()}\n\n${block}\n`, "utf8");
}

export function writeInstructionFiles(root: string): string[] {
  const files = [
    path.join(root, "AGENTS.md"),
    path.join(root, "CLAUDE.md"),
    path.join(root, "GEMINI.md"),
    path.join(root, ".cursor", "rules", "ctc.mdc"),
    path.join(root, ".windsurfrules"),
  ];
  upsert(files[0]!, "ctc-agents", INSTRUCTION);
  upsert(files[1]!, "ctc-claude", INSTRUCTION);
  upsert(files[2]!, "ctc-gemini", INSTRUCTION);
  const rule = `---\ndescription: Code Traffic Control write gate\nalwaysApply: true\n---\n\n${INSTRUCTION}`;
  fs.mkdirSync(path.dirname(files[3]!), { recursive: true });
  fs.writeFileSync(files[3]!, rule, "utf8");
  upsert(files[4]!, "ctc-windsurf", INSTRUCTION);
  return files;
}
