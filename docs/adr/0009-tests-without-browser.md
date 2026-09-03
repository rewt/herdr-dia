# ADR-0009: Test the host and panel without a browser

Status: Accepted (prototype), 2026-09-02

## Context

No command line tool can load an unpacked extension into Dia, and the host's behaviour depends
on Herdr, `gh`, git, and Claude Code's dialogs.

## Decision

Test with `node --test` and no dependencies: a fake Herdr socket implementing protocol 20, a fake
`gh` driven by scenario files that records every invocation with its identity, real git
repositories in temporary directories, the real host process driven over native messaging
framing, and the panel booted in Node against a minimal DOM. Provide an opt-in pass against real
GitHub that creates and deletes a private repository.

## Consequences

223 tests run offline in about half a minute, and any change to the host, panel or scripts can
be checked without Dia. Loading the extension and operating the panel remain manual.
