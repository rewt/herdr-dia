# ADR-0008: Keep sessions in a registry reconciled with live agents

Status: Accepted (prototype), 2026-09-02

## Context

The Active board must show sessions started by earlier host processes, since the host exits with
the panel. Herdr's agent list has the live agents but not the pull request each one belongs to.

## Decision

Record every launch in `~/.herdr-dia/sessions.json` (agent name, owner, repo, number, mode, plan
mode, URL, title, workspace and tab). `dia.sessions` joins the registry with `agent.list`,
reconstructs a record for any live agent whose name matches the extension's naming scheme but is
absent from the registry (owner and repo from the checkout's `origin`, number and mode from the
name), and forgets sessions whose agent has been gone for a day.

## Consequences

Sessions survive host restarts and a cleared registry. The registry stores no GitHub identity,
so sessions are not scoped to the identity that started them (known issue K1).
