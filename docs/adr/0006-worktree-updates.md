# ADR-0006: Run updates in a git worktree of the user's checkout

Status: Accepted (prototype), 2026-09-02

## Context

An update changes the pull request branch and must not disturb the user's working tree. The
options were the checkout itself, a fresh clone, Herdr's `worktree.create` (which forces a
workspace at the top level of its own), or a plain git worktree.

## Decision

Create a plain git worktree under `~/.herdr-dia/worktrees/<repo>/pr-<n>` on branch
`herdr-dia/pr-<n>`, sharing the checkout's `.git` so the agent's pushes reach the pull request.
Record the worktree in `~/.herdr-dia/worktrees.json`. Remove worktrees with `git worktree remove`
and never with `--force`; always retain the branch.

## Consequences

Concurrent updates of the same repository do not collide, and a worktree with uncommitted
changes is never deleted. An existing checkout under the repos root is required; without one,
the agent is instructed to clone. Hosted execution would make this decision unnecessary.
