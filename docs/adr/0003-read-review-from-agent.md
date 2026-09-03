# ADR-0003: Read the review out of the agent's pane and plan file

Status: Accepted (prototype), 2026-09-02

## Context

A review that takes minutes shows nothing in the panel until it finishes. Plan mode prevents the
agent from writing a progress file. The options were to wait for completion, to have the agent
write a file (not possible in plan mode), or to read the agent's screen.

## Decision

While the agent runs, `dia.review_text` reads the pane's scrollback (`agent.read`, source
`recent_unwrapped`, falling back to the visible screen while the agent is busy). When the agent
is parked on the exit plan dialog, the route reads the plan file named on that screen without
answering the dialog. The brief requires one line of `HERDR_DIA_RESULT {…}` JSON at the end of
the review so findings are parsed structurally.

## Consequences

Reading changes nothing; the agent stays parked until the user replies. The route depends on
Claude Code printing the plan file path on the dialog screen and on Herdr's ability to read a
pane. The panel exposes this as Peek on running reviews and Read review on ready ones.
