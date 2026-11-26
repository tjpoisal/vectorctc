# VectorCTC for VS Code (preview scaffold — not published, coming soon)

Shows the same findings as the VectorCTC pre-write gate, the pre-commit hook (`ctc install-git-hooks` or `.pre-commit-hooks.yaml`) and the CI check (`ctc ci` / `action.yml`), because it calls the same CLI: `ctc check <file> --content-from stdin --json`.

- Diagnostics on open, on save and (debounced) while typing, on the unsaved buffer.
- Each finding shows what, why and the fix. Findings the gate can fix mechanically get a quick fix that applies the gate's own patch and re-checks.
- Observe-mode findings show as information, not errors.

Status: scaffold. `src/map.mjs` is unit-tested in the main suite (`tests/v04-surfaces.test.ts`); `src/extension.js` has not been run inside VS Code on this box (no VS Code here). To try it: `code --extensionDevelopmentPath=integrations/vscode`.
