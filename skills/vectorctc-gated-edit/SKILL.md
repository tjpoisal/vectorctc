---
name: vectorctc-gated-edit
description: Use an installed VectorCTC gate to make a scoped code change, explain a held write, apply a suggested fix, or resume a blocked coding task.
---

# Make a gated edit

Confirm VectorCTC is connected, discover its live tool schemas, and read the repository instructions and active task scope. Use the setup skill if the gate is unavailable.

Use `ctc_onboard_idea` and `ctc_promote_task_to_flight_plan` when beginning a task that needs an active flight plan. Preserve an existing approved scope. Use the discovered schemas rather than inventing arguments.

Read necessary source with `ctc_read_file` and make intended edits with `ctc_write_file` or `ctc_patch_file`. Pass the intended project root when required. A patch's search must match uniquely. Treat a hold as a failed write and inspect the returned rule, line, explanation, and proposed fix.

Use `ctc_explain` for the held proposal and `ctc_apply_fix` for an appropriate mechanical correction. Review the fix against the user's task, then resubmit through the gate. Report success only when the returned result confirms clearance. Never route around a hold with native tools or shell writes. On a circuit-breaker lock, report its handoff and obtain the user's decision before resetting or widening policy.

Run checks appropriate to the accepted change and inspect its diff. State which paths were gated and any verification still pending. The gate enforces implemented rules on the paths that use it. It does not establish correctness of every change or interception of every write mechanism.
