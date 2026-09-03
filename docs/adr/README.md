# Architecture decision records

One record per decision, in the format described by Michael Nygard (title, status, context,
decision, consequences). Records are not edited after acceptance; a later decision that changes
one supersedes it with a new record. [HANDOFF.md](../../HANDOFF.md) section 5 indexes them.

| ID | Title | Status |
| --- | --- | --- |
| [ADR-0001](0001-local-runtime.md) | Run the agent on the user's machine through Herdr | Accepted |
| [ADR-0002](0002-plan-mode-gate.md) | Gate reviews with the agent's own read-only mode | Accepted |
| [ADR-0003](0003-read-review-from-agent.md) | Read the review out of the agent's pane and plan file | Accepted |
| [ADR-0004](0004-ready-state.md) | Define "ready" as done, plan dialog, or idle held 45 s | Accepted |
| [ADR-0005](0005-queue-source.md) | Build the queue from GitHub notifications and review requests | Accepted |
| [ADR-0006](0006-worktree-updates.md) | Run updates in a git worktree of the user's checkout | Accepted |
| [ADR-0007](0007-transparent-host.md) | Make the host a transparent pipe with no allowlist | Accepted |
| [ADR-0008](0008-session-registry.md) | Keep sessions in a registry reconciled with live agents | Accepted |
| [ADR-0009](0009-tests-without-browser.md) | Test the host and panel without a browser | Accepted |
