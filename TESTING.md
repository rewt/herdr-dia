# Testing herdr-dia

Tests are how an agent can tell whether a change broke something. This suite has no
dependencies — `node --test`, a fake Herdr socket, a fake `gh`, and real git repositories in
temp directories — so it runs offline in about half a minute.

```sh
npm test          # everything, offline
node --test       # the same suite, if you'd rather not go through npm
node --test test/queue.test.mjs        # one file
node --test --test-name-pattern=merge  # one behaviour
```

**After changing `host/`, `extension/`, or `scripts/`, run `npm test`.** It is the fastest way
to find out whether the panel, the host and the briefs still agree with each other.

## What is real and what is faked

| Thing | In the tests |
| --- | --- |
| The host (`host/bridge.mjs`) | Real — spawned as a process and driven over native-messaging framing, exactly as the browser does |
| Herdr | `test/fake-herdr.mjs` — a unix socket speaking protocol 20 (NDJSON, one request per connection, `events.subscribe` the only stream) |
| `gh` | `test/bin/gh` — answers from a scenario file, records every call and the identity it used |
| git | Real, in throwaway repositories (`initRepo` in `test/helpers.mjs`) |
| `~/.herdr-dia` state | Real files, in a throwaway `$HOME` |
| GitHub | Faked, unless you opt in (see below) |

Each test gets its own `$HOME`, its own socket and its own fake `gh`, so nothing leaks between
tests and nothing touches your real state. The fake `gh` is symlinked into
`$HOME/.local/bin/gh`, which is where the host puts the front of its own `PATH`.

## The files

- `test/helpers.mjs` — `withEnv()` builds an environment (throwaway home, fake Herdr, fake gh,
  a running host) and tears it down; `initRepo()` makes a real git repo; `env.ghCalls()` reads
  back what the host asked GitHub for.
- `test/fake-herdr.mjs` — the fake server. `env.herdr.addAgent(...)` puts an agent on the
  board, `failNext(...)` makes one call fail, `scriptDialog(...)` scripts a Claude Code select
  dialog (the highlight moves with the arrow keys, exactly as the host expects), `calls`
  records everything the host asked for.
- `env.restartHost()` restarts the host against the same throwaway $HOME, which is how the
  queue cache's warm-start behaviour is tested.
- `test/fake-dom.mjs` — just enough DOM and `chrome` to boot `panel.js` in Node:
  `installPanelDom({ tab, handlers })` stubs the elements and the native-messaging port, and
  `panel-render.test.mjs` then reads the rendered rows, badges and buttons back.
- `test/bin/gh` — the fake `gh`. Scenarios are plain objects (`notifications`, `requested`,
  `mine`, `users`, `repoSettings`, `mergeError`, `fail: { graphql: '…' }`); see
  `test/fixtures/github.mjs` for builders in the API's own shapes.
- One file per route or feature: `hello`, `config`, `queue`, `launch-review`, `launch-update`,
  `sessions`, `review-text`, `proceed`, `merge-pr`, `resolve-user`, `worktrees`,
  `end-session`, `subscribe`, `protocol` (the pass-through and the framing), plus
  `host-lib` and `panel-logic` for the pure functions, `panel-render` for the panel booted
  headlessly, `install` for the installer, and `sources` for the invariants an editing agent
  has to keep.

## Writing a test

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv, initRepo } from './helpers.mjs';

test('a review lands in the herdr-dia workspace', async () => {
  await withEnv({ scenario: { notifications: [] } }, async (env) => {
    initRepo(`${env.repos}/herdr-dia`, { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', {
      owner: 'rewt', repo: 'herdr-dia', number: 7, mode: 'review', reposRoot: env.repos,
    }, { timeout: 60_000 });

    assert.deepEqual(env.herdr.tabLabels(), ['herdr-dia#7 review']);
    assert.match(env.herdr.agent(launched.name).prompts[0], /plan mode/);
  });
});
```

A launch waits for the agent to hold `idle` for two polls before it sends the brief (real
Claude Code flickers between statuses), so give launch tests a generous `timeout`.

## The pure functions

`host/lib.mjs` and `extension/logic.js` hold everything that is a function of its inputs —
agent naming, `extractResult`'s brace walker, the briefs, `settled()`, the queue signature, the
merge-button rule. They import cleanly into a test, so behaviour like "`#16` and `#167` must
never share an agent name" is checked directly rather than through the wire. `panel.js` is a
module script (`<script type="module">`) that imports `logic.js`; keep DOM code out of
`logic.js` or the tests can't load it — `sources.test.mjs` enforces that.

## The real-GitHub fixtures (opt-in)

```sh
npm run test:github
```

`test/github-live.test.mjs` creates a **private, throwaway repository** under your own account,
pushes a branch, opens a real pull request and a real draft, then drives `dia.queue` and
`dia.merge_pr` against it with the real `gh` — and deletes the repository again. Herdr is still
faked; GitHub is the only real thing.

- It is skipped unless `TEST_GITHUB=1`, so `npm test` never touches the network.
- Identity: `GH_CONFIG_DIR` defaults to `~/.config/gh-work` (override with
  `TEST_GITHUB_GH_CONFIG_DIR`), and git runs with `GIT_CONFIG_COUNT=0` plus
  `~/.ssh/id_ed25519` (override with `TEST_GITHUB_SSH_KEY`) — this shell exports
  `GIT_CONFIG_*` identities that would otherwise win, and the `~/.local/bin/gh` wrapper maps
  accounts by directory, so every `gh` call is made from a directory it does not map.
- It refuses to run unless the token can also delete a repository, so it can never leave a
  fixture behind. Grant that once with:
  `GH_CONFIG_DIR=~/.config/gh-work gh auth refresh -h github.com -s delete_repo`.
- The "approved ✓ / Merge enabled" path needs a second reviewer — you cannot approve your own
  PR — so the live test asserts the merge mechanics and leaves the approval badge to
  `panel-logic.test.mjs`.

## What is not covered

Loading the extension in a real browser: there is no CLI that can load an unpacked extension
into Dia, so the final click-through is verified by hand. `panel-render.test.mjs` boots the
panel against a stub DOM, which catches the code breaking; it cannot catch the CSS, the side
panel's own behaviour, or anything Chromium does for you.
