// dia.merge_pr — merging one of your own PRs, with a method the repository actually allows.
// This is the one route that changes GitHub, so it is deliberate about how it is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './helpers.mjs';

const PR = { owner: 'rewt', repo: 'herdr-dia', number: 7 };

test('merge picks squash when the repository allows it', async () => {
  await withEnv({ scenario: { repoSettings: { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true } } }, async (env) => {
    const result = await env.host.send('dia.merge_pr', PR);
    assert.equal(result.type, 'merged');
    assert.equal(result.method, 'squash');
    assert.deepEqual(env.ghCallsMatching(/^pr merge/)[0].argv, ['pr', 'merge', '7', '--repo', 'rewt/herdr-dia', '--squash']);
  });
});

test('merge falls back to a merge commit, then to rebase', async () => {
  await withEnv({ scenario: { repoSettings: { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true } } }, async (env) => {
    assert.equal((await env.host.send('dia.merge_pr', PR)).method, 'merge');
  });
  await withEnv({ scenario: { repoSettings: { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: true } } }, async (env) => {
    assert.equal((await env.host.send('dia.merge_pr', PR)).method, 'rebase');
  });
});

test('an explicit method is used as given, without asking the repository', async () => {
  await withEnv(async (env) => {
    const result = await env.host.send('dia.merge_pr', { ...PR, method: 'rebase' });
    assert.equal(result.method, 'rebase');
    assert.deepEqual(env.ghCallsMatching(/^api repos/), [], 'no need to look up what is allowed');
  });
});

test('if the repository settings cannot be read, a merge commit is assumed', async () => {
  await withEnv({ scenario: { fail: { repo: 'HTTP 403' } } }, async (env) => {
    assert.equal((await env.host.send('dia.merge_pr', PR)).method, 'merge');
  });
});

test('a refused merge comes back as merge_failed with GitHub’s own words', async () => {
  await withEnv({ scenario: { mergeError: 'Pull request is not mergeable: the base branch requires review' } }, async (env) => {
    await assert.rejects(env.host.send('dia.merge_pr', PR), (error) => {
      assert.equal(error.herdr.code, 'merge_failed');
      assert.match(error.message, /base branch requires review/);
      assert.ok(!error.message.startsWith('gh pr merge:'), 'the gh prefix is stripped for the panel');
      return true;
    });
  });
});

test('merge_pr insists on knowing which PR', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.merge_pr', { owner: 'rewt', repo: 'herdr-dia' }), /merge_pr needs owner, repo and number/);
    assert.deepEqual(env.ghCalls().length, 0, 'nothing was merged');
  });
});

test('merge runs under the identity the panel selected', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.merge_pr', { ...PR, ghConfigDir: '~/.config/gh-work' });
    for (const call of env.ghCalls()) assert.equal(call.ghConfigDir, `${env.home}/.config/gh-work`);
    // A gh identity wrapper maps accounts by directory, so these run from a neutral one.
    for (const call of env.ghCalls()) assert.equal(call.cwd, env.tmp);
  });
});
