# Marketplace distribution

Prepared 2026-11-27 from VectorCTC 0.5.0. The npm package remains unpublished. The companion plugin provides three skills for setup, gated edits, and policy review. The CLI, MCP service, and hooks are installed from source using the existing README. Installing these instructions does not install native-write interception.

## Install the companion

Claude Code accepts this repository as a marketplace source.

```text
/plugin marketplace add tjpoisal/vectorctc
/plugin install vectorctc@vectorctc-plugins
```

Install an individual skill in a compatible client with the skills CLI.

```bash
npx skills add tjpoisal/vectorctc --skill vectorctc-setup
npx skills add tjpoisal/vectorctc --skill vectorctc-gated-edit
npx skills add tjpoisal/vectorctc --skill vectorctc-policy-review
```

For local plugin review, use `claude --plugin-dir /absolute/path/to/vectorctc`. Run `claude plugin validate /absolute/path/to/vectorctc` when Claude Code is available. Cursor discovers `.cursor-plugin/plugin.json` and the same `skills/` directory. Submit the public repository at https://cursor.com/marketplace/publish after testing the installation in Cursor.

Use the setup skill to build the source and initialize the target repository. Existing hook configurations require merging because the current initializer replaces the selected host's native-edit hook list. MCP-only access is advisory when the agent retains another write path. Verify a rejected fixture through the actual host before claiming enforcement.

## Listing copy

VectorCTC helps AI coding agents check proposed writes against repository policy before accepting them. Its free local CLI and MCP tools provide gate decisions, explanations, and local history. This companion teaches an agent to set up the supported host integration, use gated write tools, and review policy findings. Native-write enforcement depends on the configured host hooks and supported tools. Node.js 20.11 or newer is required for the source installation.

## Monetization

The Apache-2.0 local core and these companion skills are free. Local policies, reports, replay, hooks, and CLI features already provided by the core stay available. Individual at $5/month, Household at $5/seat for 2–4 seats, and Team at $8/active seat are proposed hosted plans. Hosted synchronization, organization controls and paid checkout have not been verified as available. Publish a waitlist or request-access offer until provisioning, entitlements, cancellation and billing are tested.

A paid Agensi pilot could provide repository policy assessment and a reviewed rollout artifact, with the scope and support term stated before purchase. Validate the workflow on real repositories and obtain a real price decision before publishing a paid listing. Free installation instructions remain available here. Use https://www.agensi.io/sell and clarify local MCP execution with the operator before submission.

## Channel status

Claude repository marketplace and Cursor package are prepared in this repository. Official directory approval and real-client validation remain pending. skills.sh discovers skills through genuine installs made with its CLI. The official MCP Registry package entry is blocked on a published package with ownership metadata. Glama and Smithery submission remain pending. Do not count a prepared package as an approved listing.

Use campaign links to https://vectorctc.com with `utm_source`, `utm_medium=marketplace`, and `utm_campaign=vectorctc-companion`. Keep attribution on the website and signup flow. The core remains telemetry-free. Measure setup completion, a verified first gated change, repeat use, paid conversion and support time only through explicitly disclosed collection.

## References

https://code.claude.com/docs/en/plugins/manifest-reference

https://code.claude.com/docs/en/plugins/marketplace-reference

https://cursor.com/docs/reference/plugins

https://skills.sh/docs/faq

https://registry.modelcontextprotocol.io/
