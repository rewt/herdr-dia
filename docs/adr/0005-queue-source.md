# ADR-0005: Build the queue from GitHub notifications and review requests

Status: Accepted (prototype), 2026-09-02

## Context

The Morning Brief's list of pull requests is not reachable from an extension, so the panel needs
its own list. The options were the current tab only, GitHub notifications, review requests, or
both sources combined.

## Decision

Combine notifications (`gh api notifications`) and review requests (`gh search prs
--review-requested=@me`) with the user's own pull requests (one GraphQL query), and present five
tiers: Favorites (authors the user marked, extracted from the other tiers and grouped by
author), Mine (own pull requests with review decision and mergeability), Brief (unread
notifications addressed to the user, with reason), Team (remaining review requests, by
repository) and Other (notifications that are not pull requests). Default to unapproved only. Mark the
notification thread read when a review is dispatched from it. Cache GitHub's answers per identity
for ten seconds in memory, start warm from disk for up to ten minutes, and disable Merge while a
remembered answer is displayed.

## Consequences

The tiers make the panel usable across dozens of repositories with more review requests than one
fetch returns. The queue duplicates the brief's function without access to the brief's source.
GitHub's three calls (roughly 400 to 900 ms each) are the slow path and the cache keeps the
20-second panel tick within budget.
