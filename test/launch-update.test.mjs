// dia.launch, update mode — the agent gets a git worktree of its own, as a tab in the same
// herdr-dia workspace, so two updates of one repo never touch each other's files.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, initRepo, git } from './helpers.mjs';

const PR = { owner: 'rewt', repo: 'herdr-dia', number: 7, url: 'https://github.com/rewt/herdr-dia/pull/7', title: 'Add tests' };

test('an update runs in a git worktree on its own branch', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'implement', instruction: 'bump the version', reposRoot: env.repos }, { timeout: 60_000 });

    const worktree = path.join(env.home, '.herdr-dia', 'worktrees', 'herdr-dia', 'pr-7');
    assert.equal(launched.cwd, worktree, 'never the checkout itself');
    assert.ok(fs.existsSync(path.join(worktree, '.git')));
    assert.equal(git(['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']), 'herdr-dia/pr-7');
    assert.equal(git(['-C', worktree, 'rev-parse', 'HEAD']), git(['-C', checkout, 'rev-parse', 'HEAD']));
    assert.deepEqual(env.herdr.tabLabels(), ['herdr-dia#7 update']);
    assert.equal(env.herdr.lastCall('tab.create').params.cwd, worktree);
  });
});

test('the update agent is named for the PR and gets the implement brief', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'implement', instruction: 'bump the version', reposRoot: env.repos }, { timeout: 60_000 });

    assert.match(launched.name, /^pr-7-herdr-dia-[0-9a-z]{4}$/);
    assert.equal(launched.planMode, false, 'an update has to be able to act');
    assert.deepEqual(env.herdr.agent(launched.name).args, []);
    const brief = env.herdr.agent(launched.name).prompts[0];
    assert.match(brief, /this directory is a fresh git worktree of rewt\/herdr-dia/);
    assert.match(brief, /gh pr checkout 7/);
    assert.match(brief, /bump the version/);
    assert.match(brief, /push to the PR branch/);
  });
});

test('the worktree is registered so it can be listed and torn down', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });

    const registry = env.worktreeRegistry();
    const entry = Object.values(registry)[0];
    assert.equal(Object.keys(registry).length, 1);
    assert.equal(entry.owner, 'rewt');
    assert.equal(entry.repo, 'herdr-dia');
    assert.equal(entry.number, 7);
    assert.equal(entry.branch, 'herdr-dia/pr-7');
    assert.equal(entry.sourceCheckout, checkout);
    assert.equal(entry.checkoutPath, launched.cwd);
    assert.equal(entry.id, entry.tabId, 'the tab is the handle for the worktree');
  });
});

test('two updates in one repo get separate worktrees and tabs', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const first = await env.host.send('dia.launch', { ...PR, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });
    const second = await env.host.send('dia.launch', { ...PR, number: 8, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });

    assert.notEqual(first.cwd, second.cwd);
    assert.deepEqual(env.herdr.tabLabels().sort(), ['herdr-dia#7 update', 'herdr-dia#8 update']);
    assert.equal(Object.keys(env.worktreeRegistry()).length, 2);
    assert.equal(git(['-C', second.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']), 'herdr-dia/pr-8');
  });
});

test('an update announces the worktree it is creating', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const pending = env.host.send('dia.launch', { ...PR, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });
    await pending;
    assert.match(pending.progress.join('\n'), /git worktree herdr-dia\/pr-7/);
  });
});

test('without a checkout there is no worktree — the agent is told to clone', async () => {
  await withEnv(async (env) => {
    const launched = await env.host.send('dia.launch', { owner: 'rewt', repo: 'not-cloned', number: 3, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });

    assert.equal(launched.existing, false);
    assert.equal(launched.cwd, path.join(env.repos, 'not-cloned'));
    assert.deepEqual(env.worktreeRegistry(), {});
    assert.deepEqual(env.herdr.tabLabels(), ['not-cloned#3 update']);
    assert.match(env.herdr.agent(launched.name).prompts[0], /clone the repository here first/);
  });
});

test('an unknown mode is treated as an update, never as a read-only review', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'something-else', reposRoot: env.repos }, { timeout: 60_000 });
    assert.equal(launched.mode, 'implement');
    assert.equal(launched.resultFile, null);
  });
});
