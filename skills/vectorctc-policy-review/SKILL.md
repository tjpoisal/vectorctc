---
name: vectorctc-policy-review
description: Review VectorCTC repository policy or local gate history, identify recurrent holds, and prepare a rollout or agent report without silently changing enforcement.
---

# Review gate policy and history

Locate the built CLI and target repository. Read the project instructions, `ctc.config.json`, and the active policy layers before running commands. Read the installed CLI help for exact options.

Use `ctc rules import --json` to inspect compiled and advisory instructions. Use `ctc policy explain` for effective policy and `ctc policy report` for observe-mode findings. Use `ctc report-card --json` and `ctc replay --list` for existing local evidence. If no history exists, state that rather than manufacturing activity. `ctc try` may be used as a read-only historical trial when requested, with its tested-commit count and timeout disclosed.

Explain which rules caused holds, their scope, and whether they were enforced or observed. Distinguish missing agent/model attribution from known attribution. Keep replay source snippets and secrets out of public reports.

Prepare proposed policy changes as a reviewable diff with expected effects. Use `ctc suggest-rules` to inspect available suggestions, and apply an acceptance only when the user's request covers changing policy. Re-run policy validation after any approved edit. Never weaken a locked policy or reset a breaker to make the report look better.

Return a short evidence-based report covering the current configuration, recurring problems, proposed actions, and any missing runtime verification. Local reporting is part of the free core. Hosted team governance and subscriptions require separate availability evidence.
