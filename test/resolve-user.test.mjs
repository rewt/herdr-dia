// dia.resolve_user — checking a typed favorite against GitHub so the list holds real accounts
// with their canonical casing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './helpers.mjs';

const scenario = {
  users: {
    octocat: { login: 'octocat', name: 'The Octocat', type: 'User' },
    adev_acme: { login: 'adev_acme', name: 'A Dev', type: 'User' },
    'some-org': { login: 'some-org', name: 'Some Org', type: 'Organization' },
    noname: { login: 'noname', name: null, type: 'User' },
  },
};

test('a real user resolves to its canonical login', async () => {
  await withEnv({ scenario }, async (env) => {
    const user = await env.host.send('dia.resolve_user', { login: 'octocat' });
    assert.deepEqual(user, { type: 'user', login: 'octocat', name: 'The Octocat', kind: 'User' });
  });
});

test('a leading @ and surrounding space are forgiven', async () => {
  await withEnv({ scenario }, async (env) => {
    const user = await env.host.send('dia.resolve_user', { login: '  @octocat ' });
    assert.equal(user.login, 'octocat');
  });
});

test('an enterprise login with an underscore is a valid username', async () => {
  await withEnv({ scenario }, async (env) => {
    const user = await env.host.send('dia.resolve_user', { login: 'adev_acme' });
    assert.equal(user.login, 'adev_acme');
  });
});

test('organizations resolve too, and report their kind', async () => {
  await withEnv({ scenario }, async (env) => {
    assert.equal((await env.host.send('dia.resolve_user', { login: 'some-org' })).kind, 'Organization');
  });
});

test('a user with no display name is still a user', async () => {
  await withEnv({ scenario }, async (env) => {
    assert.deepEqual(await env.host.send('dia.resolve_user', { login: 'noname' }), { type: 'user', login: 'noname', name: null, kind: 'User' });
  });
});

test('an account GitHub does not know is not_found', async () => {
  await withEnv({ scenario }, async (env) => {
    await assert.rejects(env.host.send('dia.resolve_user', { login: 'definitely-not-a-user' }), (error) => {
      assert.equal(error.herdr.code, 'not_found');
      assert.match(error.message, /no GitHub user "definitely-not-a-user"/);
      return true;
    });
  });
});

test('something that cannot be a username is rejected before GitHub is asked', async () => {
  await withEnv({ scenario }, async (env) => {
    for (const login of ['', '   ', '-starts-with-a-dash', 'has spaces', 'has/slash', 'a'.repeat(40)]) {
      await assert.rejects(env.host.send('dia.resolve_user', { login }), (error) => {
        assert.equal(error.herdr.code, 'invalid');
        return true;
      }, `"${login}" should be rejected`);
    }
    assert.deepEqual(env.ghCalls(), [], 'no round trip for an obvious typo');
  });
});

test('resolve_user runs from a neutral directory so the chosen identity decides', async () => {
  await withEnv({ scenario }, async (env) => {
    await env.host.send('dia.resolve_user', { login: 'octocat', ghConfigDir: '~/.config/gh-work' });
    const [call] = env.ghCalls();
    // The ~/.local/bin/gh wrapper maps the account by directory and would override
    // GH_CONFIG_DIR inside a mapped tree; from the temp dir the explicit setting wins.
    assert.equal(call.cwd, env.tmp);
    assert.equal(call.ghConfigDir, `${env.home}/.config/gh-work`);
    assert.deepEqual(call.argv.slice(0, 2), ['api', 'users/octocat']);
  });
});
