// dia.hello — the handshake the panel uses to prove the host is alive and to show which
// socket it is talking to.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './helpers.mjs';

test('dia.hello reports the socket, pid and home', async () => {
  await withEnv(async (env) => {
    const hello = await env.host.send('dia.hello');
    assert.equal(hello.type, 'hello');
    assert.equal(hello.socket, env.herdr.socketPath);
    assert.equal(hello.home, env.home);
    assert.equal(hello.defaultRoot, '~/herdr-dia');
    assert.ok(hello.pid > 0);
  });
});

test('the host answers before Herdr is ever contacted', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.hello');
    assert.deepEqual(env.herdr.calls, [], 'dia.hello must not touch the socket');
  });
});
