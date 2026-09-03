# ADR-0004: Define "ready" as done, plan dialog, or idle held 45 s

Status: Accepted (prototype), 2026-09-02

## Context

Claude Code's reported status alternates between `working` and `idle` between tool calls. A
panel that treats the first `idle` as completion reports a review as ready before the agent has
read the diff. The options were first idle, `done` only, or a debounce.

## Decision

A review is ready when the agent reports `done`, or is `blocked` on the exit plan dialog, or has
reported `idle` continuously for 45 seconds (`IDLE_READY_MS` in `extension/logic.js`). The launch
applies the same rule in reverse: the brief is sent only after `idle` has held for two
consecutive one second polls.

## Consequences

Readiness lags by up to 45 seconds for agents that never report `done`. The second rule treats
every blocked review as ready, including one stopped on a login prompt; this is known issue K2,
and the fix is for the host to report which dialog is showing.
