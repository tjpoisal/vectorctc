---
name: vectorctc
description: Route proposed code edits through VectorCTC before writing files. Use when modifying a repository configured for Code Traffic Control, especially when a gate returns a hold or task-scope restriction.
---
# VectorCTC pre-write workflow

1. Confirm the intended project root and authorized task. Discover the configured MCP server and its tools. If configuration is missing, stop and ask before installing or changing project policy.
2. Inspect the current file and applicable task scope. Use the exposed CTC write or patch tool appropriate to the active workflow; inspect its actual input schema rather than guessing parameters.
3. Treat a hold as a rejected proposal. Read its rule findings and correction payload, revise the proposed change, then resubmit through CTC. Never bypass a hold by switching to native edit tools, shell redirection, or disabling policy.
4. If a finding cannot be resolved within the authorized scope, explain the conflict and request maintainer guidance. Do not clear locks, weaken rules, or opt into network review without explicit authorization.
5. After a clear, inspect the actual resulting diff and run relevant tests. A gate pass is not proof of functional correctness.
6. If MCP is unavailable or a tool errors, report that gating could not be verified. Do not silently fall back to an ungated write.

## Setup

Use the source installation documented at https://github.com/tjpoisal/vectorctc until npm publication is independently confirmed. Run the built CLI with `init --agent claude`, `init --agent cursor`, or `init --agent copilot` in an authorized project; inspect generated configuration and restart the client. MCP instructions alone are advisory; native hook coverage varies by client. Do not claim enforcement until a denied native write is reproduced.

Core is Apache-2.0. No hosted subscription is required for local operation. Optional network features require informed opt-in. See https://vectorctc.com and the repository README.
