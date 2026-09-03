# ADR-0001: Run the agent on the user's machine through Herdr

Status: Accepted (prototype), 2026-09-02

## Context

Dia can read and discuss a pull request but cannot act on it. Acting requires a coding agent
with a checkout and credentials. The candidate execution locations were a hosted sandbox
holding the user's credentials, an agent embedded in the browser's chat, and an agent on the
user's machine driven through a local runtime.

## Decision

Run the agent on the user's machine through Herdr, a terminal workspace manager that exposes
agent start, screen read, status, key input, and tab and workspace lifecycle over a Unix socket.
The native messaging host is a transparent pipe to that socket plus fourteen `dia.*` routes. The
`gh` and Claude Code config directories selected in the panel are placed in each session's
environment, so the agent acts under the identity the panel is signed in as.

## Consequences

Reviews and updates run in the user's real checkout with the user's own `gh` and git; nothing
leaves the machine except what the agent does as the user. The design assumes an installed
runtime and an installed agent, which a shipped feature could not assume. The machine's
environment is inherited, including `gh` identity wrappers and direnv, which produced most of
the prototype's defects. The host lives only as long as the side panel; a launch already in
flight is completed before exit, and a running session has no owner once the panel closes.
