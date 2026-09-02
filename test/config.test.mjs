// dia.config — everything the settings sheet can offer without guessing: the gh identities on
// this machine, the agents Herdr can actually run, and the Claude Code configs to pick from.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv } from './helpers.mjs';

function ghIdentity(home, name, account) {
  const dir = path.join(home, '.config', name);
  fs.mkdirSync(dir, { recursive: true });
  if (account) fs.writeFileSync(path.join(dir, 'hosts.yml'), `github.com:\n    user: ${account}\n    git_protocol: ssh\n`);
  return dir;
}

test('config lists the gh identities with the account each authenticates', async () => {
  await withEnv(async (env) => {
    ghIdentity(env.home, 'gh', 'octocat');
    ghIdentity(env.home, 'gh-oss', 'zoe');
    ghIdentity(env.home, 'gh-work', 'acme-dev');

    const config = await env.host.send('dia.config');
    assert.equal(config.type, 'config');
    assert.deepEqual(config.identities.map((i) => i.name), ['gh', 'gh-work', 'gh-oss'], 'the default first, then by account');
    assert.deepEqual(config.identities.map((i) => i.account), ['octocat', 'acme-dev', 'zoe']);
    assert.deepEqual(config.identities.map((i) => i.isDefault), [true, false, false]);
    assert.equal(config.identities[2].dir, path.join(env.home, '.config', 'gh-oss'));
  });
});

test('an identity with no hosts.yml is still offered, without an account', async () => {
  await withEnv(async (env) => {
    ghIdentity(env.home, 'gh-empty', null);
    const config = await env.host.send('dia.config');
    assert.deepEqual(config.identities.map((i) => [i.name, i.account]), [['gh-empty', null]]);
  });
});

test('directories that are not gh configs are ignored', async () => {
  await withEnv(async (env) => {
    ghIdentity(env.home, 'gh-work', 'acme-dev');
    fs.mkdirSync(path.join(env.home, '.config', 'ghostty'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.config', 'herdr'), { recursive: true });
    const config = await env.host.send('dia.config');
    assert.deepEqual(config.identities.map((i) => i.name), ['gh-work']);
  });
});

test('the agent picker comes from Herdr’s own manifests', async () => {
  await withEnv(async (env) => {
    const config = await env.host.send('dia.config');
    assert.deepEqual(config.agents, [
      { kind: 'claude', version: '1.2.3' },
      { kind: 'codex', version: '0.9.0' },
      { kind: 'gemini', version: null },
    ]);
  });
});

test('a Herdr that cannot list its agents leaves the rest of config standing', async () => {
  await withEnv(async (env) => {
    await env.herdr.close();
    const config = await env.host.send('dia.config');
    assert.deepEqual(config.agents, []);
    assert.equal(config.defaultRoot, '~/herdr-dia');
  });
});

test('the Claude Code configs are listed, with which one is logged in', async () => {
  await withEnv(async (env) => {
    fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.claude-personal'), { recursive: true });
    fs.writeFileSync(path.join(env.home, '.claude-personal', '.credentials.json'), '{}');
    fs.mkdirSync(path.join(env.home, '.claudette'), { recursive: true });

    const config = await env.host.send('dia.config');
    const byName = Object.fromEntries(config.claudeConfigs.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['.claude', '.claude-personal']);
    assert.equal(byName['.claude'].isDefault, true);
    assert.equal(byName['.claude'].loggedIn, false);
    assert.equal(byName['.claude-personal'].loggedIn, true);
    assert.equal(byName['.claude-personal'].dir, path.join(env.home, '.claude-personal'));
  });
});

test('a machine with nothing configured still answers', async () => {
  await withEnv(async (env) => {
    const config = await env.host.send('dia.config');
    assert.deepEqual(config.identities, []);
    assert.deepEqual(config.claudeConfigs, []);
    assert.equal(config.defaultRoot, '~/herdr-dia');
  });
});
