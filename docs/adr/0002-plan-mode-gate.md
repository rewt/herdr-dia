# ADR-0002: Gate reviews with the agent's own read-only mode

Status: Accepted (prototype), 2026-09-02

## Context

A control is required between an agent reading a pull request and an agent posting on it in the
user's name. The options were an allowlist or approval layer in the host, the agent's own
permission mode, and reliance on the brief alone.

## Decision

Start Claude Code reviews in plan mode (`--permission-mode plan`). The agent can read and cannot
post, edit or clone, and the review is its plan. On completion the agent stops at its exit plan
dialog, which Herdr reports as `blocked` and the panel presents as "review ready". The user's
instruction is the approval: the host dismisses the dialog, sends the instruction with an
explicit approval to leave plan mode, and answers the agent's subsequent permission prompts.
Unrecognised prompts are left to the user in Herdr. Agents without a plan mode receive a brief
that posts the review as a comment (never an approval or a change request) and writes a findings
file.

## Consequences

No permission code was written, and a plan mode review remains in the panel until the user acts.
The gate exists for one agent only, so the guarantee is per agent. The host depends on the
wording of Claude Code's dialogs, which a release can change. Agents without a plan mode post
without a user action.
