# Distribution release runbook

Release candidate: public Apache-2.0 repository, package 0.5.0 at time of writing. Do not publish from another repository without reconciling history and ownership. No package publication is asserted here.

## Build and validate
```sh
npm ci
npm run check
npm pack --dry-run
npm pack
```
Install the resulting tarball in a disposable directory. Verify both binaries, help and version, source installation, and the README's quick start. Run the existing CI matrix. For each supported client, create a disposable Git project, initialize the integration, inspect generated config, restart the client, discover MCP tools, and demonstrate a permitted write and a denied write that leaves the file hash unchanged. Test native edit bypasses separately; report advisory mode where prevention is unsupported. Never test on customer code. Record commit, OS, Node/client version and test logs.

## Partner package
Zip skills/vectorctc/SKILL.md at the archive root. Test the skill with Claude Code, Cursor and Copilot before submitting. Agensi seller entry: https://www.agensi.io/sell. Verify acceptance of free listings and local MCP dependencies; do not assume approval. Use a versioned skill and public source link. For native plugins, verify the current platform manifest and submission requirements rather than treating a skill as a published plugin.

## Listing copy
VectorCTC — Code Traffic Control is an open-source local CLI and MCP server for routing proposed AI coding edits through deterministic project-policy checks. When a routed write is held, the agent receives findings and can revise and resubmit. Native tool enforcement depends on client hooks and configuration. Local core is free under Apache 2.0. Source: https://github.com/tjpoisal/vectorctc. Website: https://vectorctc.com. Pre-release until registry availability is confirmed.

## Commercial separation
Do not enable payment links until paid entitlements, checkout, provisioning, cancellations and refunds are tested. Use source install as the free CTA until the registry version resolves. Do not advertise preview features as generally available. Record approved marketplace URLs and verified installation results before announcing availability.
