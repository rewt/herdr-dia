// The one test that talks to GitHub for real: it creates a private throwaway repository under
// your own account, pushes a branch, opens a pull request, drives dia.queue and dia.merge_pr
// against it with the real `gh`, and deletes the repository again.
//
//   npm run test:github            (or TEST_GITHUB=1 node --test test/github-live.test.mjs)
//
// It is opt-in, so `npm test` stays offline and fast. Herdr is still faked — nothing here
// needs a running Herdr, only GitHub.
//
// Identity: everything runs with GH_CONFIG_DIR pointed at one gh config (default
// ~/.config/gh) from a directory a `gh` identity wrapper does not map, so
// the explicit config decides the account. git runs with GIT_CONFIG_COUNT=0 (this shell
// exports GIT_CONFIG_* identities that would otherwise win) and the matching ssh key.
//
// Skipped unless the token can also delete a repository: creating a fixture we cannot tear
// down would leave litter in the account.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawnHost, tmpDir, sleep } from './helpers.mjs';
import { startFakeHerdr } from './fake-herdr.mjs';

const HOME = os.homedir();
const GH_CONFIG_DIR = process.env.TEST_GITHUB_GH_CONFIG_DIR || path.join(HOME, '.config', 'gh');
const SSH_KEY = process.env.TEST_GITHUB_SSH_KEY || path.join(HOME, '.ssh', 'id_ed25519');

const ghEnv = {
  PATH: process.env.PATH,
  HOME,
  GH_CONFIG_DIR,
  GH_IDENTITY_QUIET: '1',
  NO_COLOR: '1',
};

// gh, from a directory the identity wrapper does not map, so GH_CONFIG_DIR is what decides.
function gh(args, { cwd = os.tmpdir(), allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { cwd, env: ghEnv, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`gh ${args.join(' ')}: ${String(error.stderr || error.message).trim()}`);
  }
}

// git with the chosen identity, deaf to any GIT_CONFIG_* the shell exports.
function git(args, { cwd } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME, // ssh needs the real home for its keys and known_hosts
      GIT_CONFIG_COUNT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'herdr-dia fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'herdr-dia fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com',
      GIT_SSH_COMMAND: `ssh -i ${SSH_KEY} -o IdentitiesOnly=yes -o BatchMode=yes`,
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

async function poll(what, fn, { timeout = 120_000, interval = 2000 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

test('a real private repo: the queue sees the PR, and merge_pr merges it', async (t) => {
  if (process.env.TEST_GITHUB !== '1') {
    return t.skip('opt-in: TEST_GITHUB=1 npm run test:github (creates and deletes a private repo on GitHub)');
  }
  if (!fs.existsSync(GH_CONFIG_DIR)) return t.skip(`no gh config at ${GH_CONFIG_DIR}`);

  // Preflight: who are we, and can we clean up after ourselves?
  const headers = gh(['api', 'user', '-i']);
  const login = JSON.parse(headers.slice(headers.indexOf('{'))).login;
  const scopes = (/^x-oauth-scopes:\s*(.*)$/im.exec(headers)?.[1] || '').split(',').map((s) => s.trim());
  if (!scopes.includes('delete_repo')) {
    return t.skip(`the ${login} token cannot delete repositories, so this test will not create one. Grant it with: GH_CONFIG_DIR=${GH_CONFIG_DIR} gh auth refresh -h github.com -s delete_repo`);
  }

  const repo = `herdr-dia-fixtures-${crypto.randomBytes(3).toString('hex')}`;
  const slug = `${login}/${repo}`;
  const work = tmpDir('herdr-dia-live-');
  const checkout = path.join(work, repo);
  const herdr = await startFakeHerdr({ socketPath: path.join(work, 'herdr.sock') });
  // The host runs with the real HOME (gh's token lives in the login keyring) but its own
  // TMPDIR, and is pointed at the fake Herdr — GitHub is the only real thing here.
  const host = spawnHost({
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME,
    TMPDIR: work,
    HERDR_SOCKET_PATH: herdr.socketPath,
  });

  let created = false;
  try {
    // ---------------------------------------------------------------- the fixture
    gh(['repo', 'create', slug, '--private', '--description', 'throwaway fixture for the herdr-dia test suite']);
    created = true;

    fs.mkdirSync(checkout, { recursive: true });
    git(['init', '-b', 'main', '-q', checkout]);
    fs.writeFileSync(path.join(checkout, 'README.md'), `# ${repo}\n\nA throwaway fixture created by the herdr-dia test suite.\n`);
    git(['add', '.'], { cwd: checkout });
    git(['commit', '-q', '-m', 'first commit'], { cwd: checkout });
    git(['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: checkout });
    git(['push', '-q', '-u', 'origin', 'main'], { cwd: checkout });

    git(['checkout', '-q', '-b', 'fixture-change'], { cwd: checkout });
    fs.appendFileSync(path.join(checkout, 'README.md'), '\nA line the pull request adds.\n');
    git(['commit', '-q', '-am', 'add a line'], { cwd: checkout });
    git(['push', '-q', '-u', 'origin', 'fixture-change'], { cwd: checkout });
    const prUrl = gh(['pr', 'create', '--repo', slug, '--base', 'main', '--head', 'fixture-change', '--title', 'herdr-dia fixture PR', '--body', 'Opened by the herdr-dia test suite.']);
    const number = Number(/\/pull\/(\d+)/.exec(prUrl)[1]);

    git(['checkout', '-q', 'main'], { cwd: checkout });
    git(['checkout', '-q', '-b', 'fixture-draft'], { cwd: checkout });
    fs.writeFileSync(path.join(checkout, 'draft.txt'), 'not ready\n');
    git(['add', '.'], { cwd: checkout });
    git(['commit', '-q', '-m', 'a draft'], { cwd: checkout });
    git(['push', '-q', '-u', 'origin', 'fixture-draft'], { cwd: checkout });
    const draftUrl = gh(['pr', 'create', '--repo', slug, '--draft', '--base', 'main', '--head', 'fixture-draft', '--title', 'herdr-dia fixture draft', '--body', 'A draft.']);
    const draftNumber = Number(/\/pull\/(\d+)/.exec(draftUrl)[1]);

    const askQueue = (params = {}) => host.send('dia.queue', {
      reposRoot: path.join(work, 'repos'), ghConfigDir: GH_CONFIG_DIR, repos: [slug], ...params,
    }, { timeout: 120_000 });

    // ---------------------------------------------------------------- the queue
    await t.test('the Mine tier sees your own open PR, and hides your draft', async () => {
      // GitHub computes mergeability asynchronously; wait for it to settle.
      const mine = await poll('the PR to appear in Mine as mergeable', async () => {
        const q = await askQueue();
        const found = q.mine.find((p) => p.number === number);
        return found && found.mergeable !== 'UNKNOWN' ? { q, found } : null;
      });

      assert.equal(mine.found.owner, login);
      assert.equal(mine.found.repo, repo);
      assert.equal(mine.found.title, 'herdr-dia fixture PR');
      assert.equal(mine.found.author, login);
      assert.equal(mine.found.mergeable, 'MERGEABLE');
      // Nobody can approve their own PR, so the approved badge cannot be exercised here —
      // that logic is covered in the panel unit tests instead.
      assert.equal(mine.found.reviewDecision, null, 'a fresh PR has no review decision');
      assert.equal(mine.q.mine.some((p) => p.number === draftNumber), false, 'drafts stay out of the open list');
      assert.equal(mine.q.mineState, 'open');
      assert.ok(mine.q.knownRepos.includes(repo));
    });

    await t.test('the Closed toggle shows what is finished, which is nothing yet', async () => {
      const q = await askQueue({ mineState: 'closed' });
      assert.equal(q.mineState, 'closed');
      assert.equal(q.mine.some((p) => p.number === number), false, 'the PR is still open');
    });

    // ---------------------------------------------------------------- the merge
    await t.test('merge_pr really merges it, with a method the repo allows', async () => {
      const result = await host.send('dia.merge_pr', { owner: login, repo, number, ghConfigDir: GH_CONFIG_DIR }, { timeout: 120_000 });
      assert.equal(result.type, 'merged');
      assert.equal(result.method, 'squash', 'a new repository allows squash merges');

      const state = await poll('GitHub to report the merge', () => {
        const view = JSON.parse(gh(['pr', 'view', String(number), '--repo', slug, '--json', 'state,mergedAt']));
        return view.state === 'MERGED' ? view : null;
      });
      assert.ok(state.mergedAt, 'and it has a merge timestamp');
    });

    await t.test('the merged PR moves from the open list to the closed one', async () => {
      const closed = await poll('the merged PR in the Closed list', async () => {
        const q = await askQueue({ mineState: 'closed' });
        return q.mine.find((p) => p.number === number) || null;
      });
      assert.equal(closed.number, number);
      const open = await askQueue();
      assert.equal(open.mine.some((p) => p.number === number), false, 'and it is gone from the open one');
    });

    await t.test('a merge that GitHub refuses comes back as merge_failed', async () => {
      await assert.rejects(
        host.send('dia.merge_pr', { owner: login, repo, number, ghConfigDir: GH_CONFIG_DIR }, { timeout: 120_000 }),
        (error) => {
          assert.equal(error.herdr.code, 'merge_failed', 'merging an already-merged PR');
          return true;
        },
      );
    });
  } finally {
    // ---------------------------------------------------------------- teardown
    host.child.kill('SIGKILL');
    await herdr.close();
    if (created) {
      gh(['repo', 'delete', slug, '--yes']);
      assert.equal(gh(['repo', 'view', slug], { allowFailure: true }), null, `${slug} should be gone`);
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
});
