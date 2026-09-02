// dia.worktrees / dia.remove_worktree — the update worktrees the extension created, and
// tearing them down without ever losing committed work.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, initRepo, git, writeJson } from './helpers.mjs';

// A checkout with a worktree already registered, as a launch would have left it.
function withWorktree(env, { number = 7, tabId = 'tab-7' } = {}) {
  const dir = path.join(env.repos, 'herdr-dia');
  const checkout = fs.existsSync(path.join(dir, '.git')) ? dir : initRepo(dir, { origin: 'git@github.com:rewt/herdr-dia.git' });
  const checkoutPath = path.join(env.home, '.herdr-dia', 'worktrees', 'herdr-dia', `pr-${number}`);
  const branch = `herdr-dia/pr-${number}`;
  git(['-C', checkout, 'worktree', 'add', '-q', checkoutPath, '-b', branch, 'HEAD']);
  const registry = env.worktreeRegistry();
  registry[tabId] = { id: tabId, workspaceId: 'w1', tabId, owner: 'rewt', repo: 'herdr-dia', number, branch, checkoutPath, sourceCheckout: checkout, createdAt: new Date().toISOString() };
  writeJson(env.statePath('worktrees.json'), registry);
  return { checkout, checkoutPath, branch, tabId };
}

test('worktrees lists what exists, and whether it is clean', async () => {
  await withEnv(async (env) => {
    const { checkoutPath, branch } = withWorktree(env);
    const { worktrees } = await env.host.send('dia.worktrees');
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0].branch, branch);
    assert.equal(worktrees[0].checkoutPath, checkoutPath);
    assert.equal(worktrees[0].clean, true);
    assert.equal(worktrees[0].exists, true);
  });
});

test('an uncommitted change makes a worktree dirty', async () => {
  await withEnv(async (env) => {
    const { checkoutPath } = withWorktree(env);
    fs.writeFileSync(path.join(checkoutPath, 'scratch.txt'), 'work in progress\n');
    const { worktrees } = await env.host.send('dia.worktrees');
    assert.equal(worktrees[0].clean, false);
  });
});

test('a worktree removed behind our back is reported as gone', async () => {
  await withEnv(async (env) => {
    const { checkout, checkoutPath } = withWorktree(env);
    git(['-C', checkout, 'worktree', 'remove', checkoutPath]);
    const { worktrees } = await env.host.send('dia.worktrees');
    assert.equal(worktrees[0].exists, false);
    assert.equal(worktrees[0].clean, null);
  });
});

test('worktrees come back newest first', async () => {
  await withEnv(async (env) => {
    withWorktree(env, { number: 7, tabId: 'tab-7' });
    const reg = env.worktreeRegistry();
    reg['tab-7'].createdAt = '2026-09-01T10:00:00.000Z';
    writeJson(env.statePath('worktrees.json'), reg);
    withWorktree(env, { number: 8, tabId: 'tab-8' });
    const { worktrees } = await env.host.send('dia.worktrees');
    assert.deepEqual(worktrees.map((w) => w.number), [8, 7]);
  });
});

test('removing a clean worktree keeps the branch and closes the tab', async () => {
  await withEnv(async (env) => {
    const { checkout, checkoutPath, branch, tabId } = withWorktree(env);
    // Work that was committed must survive the teardown.
    fs.writeFileSync(path.join(checkoutPath, 'fix.txt'), 'the fix\n');
    git(['-C', checkoutPath, 'add', '.']);
    git(['-C', checkoutPath, 'commit', '-q', '-m', 'the fix']);
    const sha = git(['-C', checkoutPath, 'rev-parse', 'HEAD']);

    const result = await env.host.send('dia.remove_worktree', { id: tabId });
    assert.equal(result.type, 'worktree_removed');
    assert.equal(result.branch, branch);
    assert.equal(fs.existsSync(checkoutPath), false, 'the directory is gone');
    assert.equal(git(['-C', checkout, 'rev-parse', branch]), sha, 'the commit lives on in the branch');
    assert.deepEqual(env.worktreeRegistry(), {}, 'and is forgotten');
    assert.equal(env.herdr.lastCall('tab.close').params.tab_id, tabId);
  });
});

test('a dirty worktree is refused, not forced', async () => {
  await withEnv(async (env) => {
    const { checkoutPath, tabId } = withWorktree(env);
    fs.writeFileSync(path.join(checkoutPath, 'scratch.txt'), 'unsaved\n');

    await assert.rejects(env.host.send('dia.remove_worktree', { id: tabId }), (error) => {
      assert.equal(error.herdr.code, 'worktree_dirty');
      assert.match(error.message, /commit or discard them first/);
      return true;
    });
    assert.ok(fs.existsSync(path.join(checkoutPath, 'scratch.txt')), 'the work is still there');
    assert.ok(env.worktreeRegistry()[tabId], 'and it stays on the list');
    assert.deepEqual(env.herdr.callsTo('tab.close'), [], 'the tab is left open too');
  });
});

test('force removes a dirty worktree when the user insists', async () => {
  await withEnv(async (env) => {
    const { checkoutPath, tabId } = withWorktree(env);
    fs.writeFileSync(path.join(checkoutPath, 'scratch.txt'), 'unsaved\n');
    const result = await env.host.send('dia.remove_worktree', { id: tabId, force: true });
    assert.equal(result.type, 'worktree_removed');
    assert.equal(fs.existsSync(checkoutPath), false);
  });
});

test('removing a worktree whose directory is already gone just forgets it', async () => {
  await withEnv(async (env) => {
    const { checkout, checkoutPath, tabId } = withWorktree(env);
    git(['-C', checkout, 'worktree', 'remove', checkoutPath]);
    const result = await env.host.send('dia.remove_worktree', { id: tabId });
    assert.equal(result.type, 'worktree_removed');
    assert.deepEqual(env.worktreeRegistry(), {});
  });
});

test('removing something that was never registered is not an error', async () => {
  await withEnv(async (env) => {
    const result = await env.host.send('dia.remove_worktree', { id: 'never-existed' });
    assert.deepEqual(result, { type: 'worktree_removed', id: 'never-existed', branch: null });
  });
});

test('remove_worktree needs an id', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.remove_worktree', {}), /remove_worktree needs an id/);
  });
});

test('no worktrees is an empty list, not a failure', async () => {
  await withEnv(async (env) => {
    assert.deepEqual(await env.host.send('dia.worktrees'), { type: 'worktrees', worktrees: [] });
  });
});
