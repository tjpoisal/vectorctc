// VectorCTC VS Code extension (scaffold). Runs `ctc check <file> --content-from stdin --json` on the
// buffer (debounced while typing, and on save), shows the findings as diagnostics, and offers the gate's
// own suggested patch as a quick fix. The extension never decides anything itself: the CLI does, so the
// editor, the agent's pre-write gate, the pre-commit hook and the CI check always agree.
const vscode = require("vscode");
const { spawn } = require("node:child_process");
const path = require("node:path");

let mapModule;
async function map() {
  mapModule ??= await import("./map.mjs");
  return mapModule;
}

function runCheck(root, relative, text, command) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(bin, [...args, "check", relative, "--content-from", "stdin", "--json"], { cwd: root, env: { ...process.env, CTC_ROOT: root, CTC_FINDINGS_LOG: "off" } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    child.stdin.end(text);
  });
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection("vectorctc");
  const fixes = new Map();
  const timers = new Map();
  const config = () => vscode.workspace.getConfiguration("vectorctc");

  async function check(document) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== "file") return;
    const relative = path.relative(folder.uri.fsPath, document.uri.fsPath).split(path.sep).join("/");
    const payload = await runCheck(folder.uri.fsPath, relative, document.getText(), config().get("command"));
    if (!payload) return;
    const { toDiagnostics } = await map();
    const severities = { error: vscode.DiagnosticSeverity.Error, warning: vscode.DiagnosticSeverity.Warning, information: vscode.DiagnosticSeverity.Information };
    const items = toDiagnostics(payload);
    fixes.set(document.uri.toString(), items);
    collection.set(
      document.uri,
      items.map((item) => {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(item.range.startLine, item.range.startCol, item.range.endLine, item.range.endCol), item.message, severities[item.severity]);
        diagnostic.code = item.code;
        diagnostic.source = item.source;
        return diagnostic;
      }),
    );
  }

  function schedule(document) {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => check(document), config().get("debounceMs")));
  }

  context.subscriptions.push(
    collection,
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((event) => config().get("checkOnType") && schedule(event.document)),
    vscode.commands.registerCommand("vectorctc.checkFile", () => vscode.window.activeTextEditor && check(vscode.window.activeTextEditor.document)),
    vscode.commands.registerCommand("vectorctc.applyFix", async (uri, hunks) => {
      const document = await vscode.workspace.openTextDocument(uri);
      const { applyHunks } = await map();
      const next = applyHunks(document.getText(), hunks);
      if (next === null) return vscode.window.showWarningMessage("VectorCTC: the fix no longer applies; re-check the file.");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), next);
      await vscode.workspace.applyEdit(edit);
      await check(document);
    }),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, {
      provideCodeActions(document, range) {
        return (fixes.get(document.uri.toString()) ?? [])
          .filter((item) => item.fix && item.range.startLine <= range.end.line && item.range.endLine >= range.start.line)
          .map((item) => {
            const action = new vscode.CodeAction(item.fix.title, vscode.CodeActionKind.QuickFix);
            action.command = { command: "vectorctc.applyFix", title: item.fix.title, arguments: [document.uri, item.fix.hunks] };
            return action;
          });
      },
    }),
  );
}

module.exports = { activate, deactivate() {} };
