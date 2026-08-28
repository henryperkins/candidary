# Repository agent guidance

## Keep evidence loops proportional

When executing a written remediation or implementation plan with subagents:

- Use one fresh implementer and one fresh independent reviewer per task.
- Run only the task's named focused RED/GREEN checks. Do not run repository-wide gates unless the user explicitly requests them.
- Avoid redundant verification: do not repeat the same focused union separately as implementer, reviewer, and controller when a fresh successful run already provides the required evidence.
- Treat a review with no Critical or Important findings as sufficient to advance. Record Minor coverage or polish notes, but do not start a remediation/re-review loop for them unless they expose a probable production defect or the user explicitly asks.
- Start a fix loop only for a failing focused check or a Critical/Important finding. Send fixes to the original implementer, then use one scoped re-review of the changed area.
- Keep reports concise: record the command, result, relevant invariants, and open findings. Do not expand already-proven behavior into exhaustive new evidence matrices.
- Preserve any plan-level instruction to commit only once at the end, and do not stage intermediate task changes.

The goal is strong, task-scoped evidence without exorbitant evidence-generation or duplicate review cycles.
