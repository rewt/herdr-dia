# AGENTS.md — herdr-dia, explained

This file is for AI coding agents (Claude Code, Codex, Gemini, Cursor, Grok, Qwen, …). It is
the long version: what this repository is, how every part behaves, and how to work on it. The
[README](README.md) is the short human tour.

If a user says **"install herdr-dia"**, follow *Install* below and do it for them; the only
thing they do by hand is one click to load the extension.

herdr-dia is a Dia (or any Chromium) browser extension plus a Node native-messaging host that
bridges the extension to a locally running [Herdr](https://herdr.dev) session, so a GitHub pull
request the user is reading becomes a Herdr coding-agent review or update.

## Install

Prerequisites: **Node 20+**, **Herdr** installed and running (`herdr`), and **Dia** (or Chrome /
Arc / Brave / Edge / Chromium). Then, from the repo root:

```sh
node scripts/install.mjs
```

That registers the native-messaging host for every Chromium browser it finds, pins the
extension's id, and prints an install summary ending with the one manual step. Do these for the
user:

1. Run the command above. Report the printed **extension id** and whether the **Herdr socket**
   was reachable (if not, tell them to start Herdr with `herdr`).
2. Tell the user to load the extension — this is the only step you can't script:
   > In Dia, open the extensions page → turn on developer mode → **Load unpacked** → choose the
   > `extension/` directory (the installer prints its full path).
3. Have them click the **herdr-dia** toolbar icon. The panel header should show a green
   `~/.config/herdr/herdr.sock`. If it shows red, the host isn't registered for that browser or
   Herdr isn't running — re-run the installer and confirm `herdr status`.

No secrets or accounts are needed. The extension talks only to the local Herdr socket; nothing
leaves the machine except what an agent the user launches does with their own `gh`/git.

## Layout

- `host/bridge.mjs` — the native-messaging host: a transparent pipe to the Herdr socket plus the
  `dia.*` routes below. No allowlist, no auth — it runs with the user's own filesystem/Herdr
  access by design.
- `host/lib.mjs` — the host's pure parts (agent naming, the briefs, the `HERDR_DIA_RESULT`
  parser, repo resolution), split out so the tests can import them.
- `extension/` — MV3 extension: `panel.js` (the side panel), `manifest.json`, `panel.css`.
- `extension/logic.js` — the panel's decisions with no DOM (status wording, the merge rule, the
  queue fingerprint); `panel.js` is a module script that imports it.
- `test/` — the suite (`npm test`). See [TESTING.md](TESTING.md).
- `scripts/install.mjs` — host registration + extension-id pinning (idempotent, cross-platform).
- `scripts/smoke.mjs` — drive the host without a browser: `node scripts/smoke.mjs` (hello +
  agent list), `--agent claude` (throwaway launch), `--review owner/repo#N` (a real plan-mode
  review), `--queue` (the review queue).
- `scripts/demo.mjs` — serve the real panel against invented fixtures (`docs/demo/fixtures.js`),
  no Herdr or GitHub needed. `scripts/screenshots.mjs` retakes `docs/screenshots/` from it.

## Working on it

- **Run `npm test` after any change to `host/`, `extension/` or `scripts/`.** Zero-dependency
  (`node --test`, a fake Herdr socket, a fake `gh`, real git temp repos), about half a minute
  offline — see [TESTING.md](TESTING.md) for the harness and how to add to it.
  `npm run test:github` additionally creates and deletes a private throwaway repo on GitHub to
  exercise the queue and a real merge; it is opt-in.
- After editing `host/bridge.mjs` or the extension, `node --check` both, then reload the
  extension in the browser (host changes are picked up on the panel's next connect).
- State lives in `~/.herdr-dia/` (sessions, worktrees, review results) — never in a checkout.
- Keep the design principle: the browser dispatches and observes; anything irreversible
  (push, sign, broadcast) stays the user's to trigger.

## Agent-agnostic by design

The panel's **Settings → Agent** dropdown is populated live from Herdr's own agent manifests
(`server.agent_manifests`), so whatever Herdr supports on this machine — `claude`, `codex`,
`gemini`, `grok`, `qwen`, `cursor`, `amp`, `opencode`, … — is selectable, and reviews/updates
launch that agent. Plan mode is a Claude Code flag; other agents get the direct brief instead.
Adding support for another agent is a data change (Herdr detects it), not a code change here.

## The wire

```
Dia side panel ── native messaging (stdio, 4-byte LE length + JSON) ── host/bridge.mjs
                                                                             │
                                                    ~/.config/herdr/herdr.sock│
                                                                             ▼
                                                                          Herdr
```

Messages both ways are `{ id, method, params }` → `{ id, result | error }`, exactly Herdr's
shape. Anything the host doesn't recognize is forwarded to Herdr as-is, so the panel can call
any Herdr method. Long-running routes stream `{ id, progress }` lines before their result.
Subscription events arrive as `{ subscription, event, data }`.

Herdr facts worth knowing (0.8.2, protocol 20):

- Herdr answers **one request per connection** and closes it; the host opens a fresh connection
  per call. `events.subscribe` is the only long-lived stream.
- Lifecycle event types use underscores (`pane_agent_detected`); subscription kinds use dots
  (`pane.agent_status_changed`), and that one is subscribed **per pane**, so the panel
  re-subscribes when the set of agent panes changes and polls every 5 s as a safety net.
- `workspace.create` returns the root pane; `agent.start` needs that `pane_id`; `agent.prompt`
  targets the unique agent name. `agent.read` sources: `visible | recent | recent_unwrapped |
  detection`.
- `agent.start` right after `workspace.create` can answer `agent_pane_busy` (the pane's shell
  isn't up yet) — the host retries for ~20 s.
- A fresh Claude Code checkout stops at its folder-trust question with "No, exit" preselected.
  The host answers Down, then Enter **as separate writes** — coalesced keys reach the dialog as
  an Escape, which exits. Any other blocked state is the user's to answer in Herdr; the brief
  follows once the agent is idle.
- Claude Code's status flickers `working → idle → working` between tool calls, so "finished"
  means `done`, or `idle` held across several polls.

Host log: `$TMPDIR/herdr-dia-host.log`.

## Host routes

| Route | What it does |
| --- | --- |
| `dia.hello` | Handshake: socket path, pid, home, default repos root. |
| `dia.subscribe` | Opens the one Herdr event stream and relays its events to the panel. |
| `dia.config` | What this machine has: `gh` config dirs (with the account each authenticates), the agents Herdr knows, the `~/.claude*` logins. |
| `dia.queue` | The review queue: five tiers, filtered and decorated (below). Takes `force: true` to bypass the cache; answers carry `fetchedAt`, and `stale: true` when the answer came from a remembered one. |
| `dia.launch` | PR + instruction → workspace tab → agent → brief. The only route that starts work. |
| `dia.sessions` | The Active board: the session registry joined with Herdr's live agents, self-healing. |
| `dia.review_text` | Reads a finished review back out of the agent (plan file, or its scrollback). |
| `dia.proceed` | Sends the user's instruction and answers Claude's own dialogs on their behalf. |
| `dia.merge_pr` | Merges one of the user's own PRs, with a method the repo allows. |
| `dia.resolve_user` | Checks a typed favourite against the GitHub API. |
| `dia.worktrees` / `dia.remove_worktree` | List update worktrees; remove one (never with `--force`, always keeping the branch). |
| `dia.end_session` / `dia.dismiss_session` | Close a session out (tab + worktree), or just forget it. |

### dia.queue

Five tiers, from `gh api notifications` and `gh search prs`:

- **Favourites** — PRs by authors the user marked, *pulled out* of brief/team and grouped by
  author. Prioritizing, not filtering.
- **Mine** — the user's own PRs (one GraphQL query for `reviewDecision` + `mergeable`, with a
  REST search as fallback so the tier is never empty on an enrichment error). Open hides drafts;
  a toggle switches to closed/merged.
- **Brief** — PRs with an unread notification addressed to them, newest first, with the reason
  and the thread id (dispatching a review marks that thread read).
- **Team** — everything else requesting their review, grouped by repository.
- **Other** — non-PR notifications (deployment approvals, CI) as links.

Each PR is decorated with any review result already written for it and any agent working on it.
`repos` scopes every tier; `onlyUnapproved` (default on) narrows the search itself.

Answers are memoised, because GitHub's three calls are the slow part (roughly 400-900 ms each)
and the panel re-asks on every filter change and every 20-second tick, while the underlying
lists change on the order of minutes. Only GitHub's half is remembered: the repo filter,
favourites, live agent status and review results are recomputed on every call, so a cache hit is
still an accurate picture of what is running on this machine.

- `HERDR_DIA_QUEUE_TTL_MS` (default 10 s) is the freshness window. **Keep it under the panel's
  20-second tick** — at or above it, a tick gets served from cache and real freshness drifts
  toward 40 s.
- Cache keys carry the `gh` config dir, so a queue fetched under one login can never be served
  to another. On disk that is one file per identity under `~/.herdr-dia/queue-cache/`, named by
  a hash of the identity; the host lives only as long as the panel, so without this every reopen
  would start cold. An answer remembered more than 10 minutes ago is not served on a cold start.
- The panel shows the age in the queue's eyebrow ("just now", "2m ago", "remembered",
  "checking…") and clicking it re-asks with `force`. While a remembered answer is on screen,
  Merge is disabled — merging on a stale view is exactly the wrong risk to take.

### dia.launch and the review flow

Reviews default to Claude Code's plan mode (`--permission-mode plan`): the agent may read but
not act, and the review *is* its plan — summary, recommendation, findings with severity and
`file:line`, ending in one line of `HERDR_DIA_RESULT {…}` JSON.

When it finishes, Claude Code parks on its own exit-plan dialog, which Herdr reports as
`blocked`; the panel reads that as **review ready**. `dia.review_text` then reads the plan file
Claude names on that screen — the full review, without touching the dialog. Sending an
instruction is the approval: `dia.proceed` picks "Tell Claude what to change", hands over the
instruction, and from then on answers the ceremony (the exit-plan dialog, and ordinary tool
prompts, preferring "switch to accept edits for this session"). Anything unrecognized is left
for the user in Herdr.

With plan mode off, the review agent instead posts its review as a *comment* (never an approval
or a change request) and writes a findings file to
`~/.herdr-dia/reviews/<owner>/<repo>/<n>.json`.

### Where agents run

Everything the extension launches lives in one workspace named **`herdr-dia`**, discovered by
label so it survives host restarts. Each PR is a **tab** in it, labeled `<repo>#<n> review|update`.
`workspace.create` always leaves an empty root shell tab (Herdr labels it a bare number); the
host sweeps those after each launch, so the workspace holds only sessions and closes itself when
the last one ends.

The repos root is searched for an existing checkout — `<root>/<repo>`, `<root>/<owner>/<repo>`,
or one level down — whose `origin` matches. Existing checkouts are already trusted by Claude
Code and carry the tree's identities.

- **Review** runs a tab in the checkout. Plan mode never writes, so the working branch is
  untouched, and any number can run at once.
- **Update** runs a tab in its **own git worktree** (`git worktree add`, branch
  `herdr-dia/pr-<n>`, under `~/.herdr-dia/worktrees/`). Plain git, not Herdr's `worktree.create`,
  which would force its own top-level workspace. The worktree shares the checkout's `.git`, so
  the agent's commits and `git push` reach the PR branch exactly as if the user had pushed them.
- No checkout yet: the tab opens at `<root>/<repo>` and the brief tells the agent to clone there.

Tearing down is non-destructive: `git worktree remove` **without** `--force` refuses a dirty
tree and always keeps the branch, so committed work survives.

### Sessions

Every launch is recorded in `~/.herdr-dia/sessions.json` (agent name → PR context), so the board
can show each as its own interactive session regardless of what the queue currently holds.
`dia.sessions` joins that with `agent.list` and **self-heals**: any live `rv-`/`pr-` agent that
isn't in the registry is reconstructed — owner/repo from the checkout's git remote, the number
and mode from the agent name — and the rest is filled in from the review's `HERDR_DIA_RESULT`
when it's read. Sessions whose agent is gone are forgotten after a day.

**End** closes a session out: it shuts the session's Herdr tab (which stops the agent in it) and
removes a clean update worktree. Telling the *agent* "end the session" only messages the AI — it
can't close its own tab.

## Identities and environment

Two settings travel into each workspace's environment: `GH_CONFIG_DIR` (the `gh` login for the
queue and the agent's pushes) and `CLAUDE_CONFIG_DIR` (the Claude Code login the agent runs
under — set this if a fresh agent says "Login expired").

Two traps the host works around:

- **direnv.** The Herdr server inherits whatever direnv exported where it was launched; a pane
  starting in a directory with no `.envrc` "unloads" and reverts those variables. The host
  clears `DIRENV_DIFF/DIR/FILE/WATCHES` in the workspace env so the identities survive.
- **`gh` identity wrappers.** A `~/.local/bin/gh` wrapper that maps accounts by directory will
  override `GH_CONFIG_DIR` inside a mapped tree, so the host runs `gh` from a neutral directory
  (`os.tmpdir()`) unless a cwd is required — then the explicit config dir is what decides.

## Settings reference

The gear opens the settings sheet; every dropdown is built from `dia.config`:

- **Repos root** — where checkouts live.
- **GitHub identity** — the `gh` config dirs under `~/.config`, each labeled with its account.
- **Claude login** — the `~/.claude*` config dirs.
- **Agent** — the coding agents Herdr has installed. This is the model choice.
- **Review default** — Plan (the agent proposes, you decide) or Auto (it posts directly).
  Updates always act in a worktree and ignore this.
- **Repositories** — chips built from what's currently requesting review; none selected = all.
- **Favourite users** — chips from the authors in the queue, or type a username and **Add** (it
  is resolved against the GitHub API first, so a typo can't slip in).
- **Unapproved PRs only** — on by default.
- **Worktrees** — every update worktree with its branch and clean/dirty state, and Remove /
  Tidy clean worktrees.
