# ADR-0007: Make the host a transparent pipe with no allowlist

Status: Accepted (prototype), 2026-09-02

## Context

The native messaging host runs with the user's filesystem and Herdr access. The options were an
allowlist of Herdr methods, an authorization layer in the host, or a transparent pipe.

## Decision

Forward any unrecognised method to Herdr unchanged and return Herdr's answer unchanged; add
`dia.*` routes only for operations of several steps. The design rule is that the browser dispatches and
observes, and every irreversible action (post, push, merge) requires a user action in the panel.
The installer pins the extension id in the host manifest's `allowed_origins`.

## Consequences

The host is small and fully testable through the same framing the browser uses. The security
boundary is the machine and the user's identity rather than anything in the extension. The
design is not acceptable as it stands for hosted execution or for a surface reachable by
third-party code.
