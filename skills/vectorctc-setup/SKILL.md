---
name: vectorctc-setup
description: Set up or troubleshoot VectorCTC in a repository when a user wants AI edits checked before writing, or needs Claude Code, Cursor, or Copilot gate integration.
---

# Set up VectorCTC

Read the project's instructions and inspect its worktree before changing configuration. Detect the host agent and the project root. Read this repository's README for the current installation status.

Locate an existing `ctc` executable or a built VectorCTC checkout. Run its `--version` and `--help` before using it. The npm package was unpublished when this skill was prepared. Use the documented source build until `npm view vectorctc version` confirms a release. Install only the intended VectorCTC package, and verify its repository and version.

For a source build, clone `https://github.com/tjpoisal/vectorctc.git` into a dedicated tools directory, inspect the checkout, then run `npm ci` and `npm run build`. Invoke it with `node /absolute/path/to/vectorctc/dist/index.js` from the target project. Keep that absolute entry path for subsequent commands.

Before initialization, inspect `ctc.config.json`, `.mcp.json`, `.claude/settings.json`, `.cursor/mcp.json`, `.cursor/hooks.json`, and `.vscode/mcp.json` when present. The current initializer replaces the native-edit hook list for the selected host. If hooks already exist, prepare initialization in a disposable directory and merge the generated CTC entries into the real configuration while preserving existing entries. Review the resulting diff.

Run the equivalent of `ctc init --agent claude`, `ctc init --agent cursor`, or `ctc init --agent copilot` for the chosen host. Use `--strict` only when the user has requested that mode. For other agents use the actual `ctc init --help` options and report their enforcement boundary.

Verify the MCP server is connected and enumerate its tools. Exercise a harmless allowed write and a deliberately disallowed write in a disposable fixture, using the host's native write path when available. Verify the rejected content never landed. Clean up only that fixture. A successful MCP connection alone proves tool availability, not native-write interception.

Explain the installed enforcement mode and any paths that remain advisory, including shell writes. Keep `.ctc` replay diffs and logs private unless the user authorizes sharing. Report installation, fixture validation, and real-client validation separately.
