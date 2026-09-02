// scripts/install.mjs — the one command an agent runs when a user says "install herdr-dia".
// It is run against a copy of the repo in a throwaway HOME, so a test never registers
// anything with the real browsers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, tmpDir } from './helpers.mjs';

// A copy of the repo plus a throwaway HOME, so install.mjs can write its runner and host
// manifests without touching the checkout or the real browser profiles.
function installEnv() {
  const base = tmpDir('herdr-dia-install-');
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const dir of ['host', 'extension', 'scripts']) fs.cpSync(path.join(ROOT, dir), path.join(repo, dir), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(repo, 'package.json'));
  return { base, repo, home };
}

function install(env, extra = {}) {
  return execFileSync(process.execPath, [path.join(env.repo, 'scripts', 'install.mjs')], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: env.home, HERDR_SOCKET_PATH: path.join(env.home, 'herdr.sock'), ...extra },
  });
}

const hostManifest = (env, browser) => JSON.parse(fs.readFileSync(
  path.join(env.home, 'Library', 'Application Support', browser, 'NativeMessagingHosts', 'com.herdr.dia_bridge.json'), 'utf8',
));

test('install registers the native host for Dia and prints what to do next', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the manifest locations differ per platform');
  const env = installEnv();
  const output = install(env);

  const manifest = hostManifest(env, 'Dia');
  assert.equal(manifest.name, 'com.herdr.dia_bridge');
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, path.join(env.repo, 'host', 'run.sh'));
  assert.match(manifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);

  assert.match(output, /extension id\s+: [a-p]{32}/);
  assert.match(output, new RegExp(`Load unpacked[\\s\\S]*${path.join(env.repo, 'extension')}`));
  assert.match(output, /NOT reachable/, 'it says so when Herdr is not running');
  fs.rmSync(env.base, { recursive: true, force: true });
});

test('the runner pins an absolute node path, because browsers start hosts with a bare PATH', async (t) => {
  if (process.platform !== 'darwin') return t.skip('POSIX runner only');
  const env = installEnv();
  install(env);
  const runner = path.join(env.repo, 'host', 'run.sh');
  const script = fs.readFileSync(runner, 'utf8');
  assert.match(script, new RegExp(`^exec "${process.execPath}" "${path.join(env.repo, 'host', 'bridge.mjs')}"$`, 'm'));
  assert.ok(fs.statSync(runner).mode & 0o111, 'and it is executable');
  fs.rmSync(env.base, { recursive: true, force: true });
});

test('the extension id is stable across installs, so the host manifest keeps matching', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the manifest locations differ per platform');
  const env = installEnv();
  const first = install(env);
  const second = install(env);
  const id = (output) => /extension id\s+: (\S+)/.exec(output)[1];
  assert.equal(id(first), id(second), 'the pinned key in manifest.json decides it');
  assert.equal(hostManifest(env, 'Dia').allowed_origins[0], `chrome-extension://${id(first)}/`);
  fs.rmSync(env.base, { recursive: true, force: true });
});

test('a browser that is installed is registered; one that is not is skipped', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the manifest locations differ per platform');
  const env = installEnv();
  fs.mkdirSync(path.join(env.home, 'Library', 'Application Support', 'Google', 'Chrome'), { recursive: true });
  const output = install(env);

  assert.match(output, /registered for\s+: Dia, Chrome/);
  assert.equal(hostManifest(env, 'Google/Chrome').name, 'com.herdr.dia_bridge');
  assert.equal(fs.existsSync(path.join(env.home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts')), false);
  fs.rmSync(env.base, { recursive: true, force: true });
});

test('install notices a reachable Herdr socket', async (t) => {
  if (process.platform !== 'darwin') return t.skip('the manifest locations differ per platform');
  const { startFakeHerdr } = await import('./fake-herdr.mjs');
  const env = installEnv();
  const herdr = await startFakeHerdr({ socketPath: path.join(env.home, 'herdr.sock') });
  const output = install(env);
  assert.match(output, /herdr socket\s+:.*\(reachable\)/);
  await herdr.close();
  fs.rmSync(env.base, { recursive: true, force: true });
});
