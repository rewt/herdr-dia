// The host as a pipe: anything that is not a dia.* route goes to Herdr as-is and comes back
// as-is, and the native-messaging framing holds up under bad input and big answers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv, waitFor, herdrCall } from './helpers.mjs';

test('an unknown method is forwarded to Herdr untouched', async () => {
  await withEnv(async (env) => {
    const pong = await env.host.send('ping', { hello: true });
    assert.deepEqual(pong, { type: 'pong', protocol: 20 });
    assert.deepEqual(env.herdr.lastCall('ping').params, { hello: true }, 'params travel verbatim');
  });
});

test('the panel can drive Herdr directly through the host', async () => {
  await withEnv(async (env) => {
    const created = await env.host.send('workspace.create', { cwd: env.home, label: 'somewhere-else' });
    assert.ok(created.workspace.workspace_id);
    assert.deepEqual(env.herdr.workspaceLabels(), ['somewhere-else']);
    assert.deepEqual(await env.host.send('agent.focus', { target: 'whatever' }), { type: 'focused', target: 'whatever' });
  });
});

test('a Herdr error keeps its code so the panel can react to it', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('tab.close', { tab_id: 'nope' }), (error) => {
      assert.equal(error.herdr.code, 'tab_not_found');
      return true;
    });
    await assert.rejects(env.host.send('what.is.this'), (error) => {
      assert.equal(error.herdr.code, 'unknown_method');
      return true;
    });
  });
});

test('a socket that is not there is reported, not hidden', async () => {
  await withEnv(async (env) => {
    await env.herdr.close();
    await assert.rejects(env.host.send('ping'), (error) => {
      assert.equal(error.herdr.code, 'host_error');
      assert.match(error.message, /herdr socket .*herdr\.sock/);
      return true;
    });
  });
});

test('a message with no method is refused', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send(undefined, {}), /message has no method/);
  });
});

test('a malformed frame is answered with bad_json, and the host keeps going', async () => {
  await withEnv(async (env) => {
    env.host.writeRaw('{not json at all');
    await waitFor(() => env.host.orphan, { what: 'the parse error' });
    assert.equal(env.host.orphan.error.code, 'bad_json');
    assert.deepEqual(await env.host.send('ping'), { type: 'pong', protocol: 20 }, 'still answering');
  });
});

test('two requests in one write are both answered', async () => {
  await withEnv(async (env) => {
    const [a, b] = await Promise.all([env.host.send('ping'), env.host.send('server.agent_manifests')]);
    assert.equal(a.protocol, 20);
    assert.equal(b.manifests.length, 3);
  });
});

test('an answer too big for native messaging comes back as an error, not a broken pipe', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'chatty', scrollback: 'x'.repeat(1_100_000) });
    await assert.rejects(env.host.send('agent.read', { target: 'chatty', source: 'recent' }), (error) => {
      assert.equal(error.herdr.code, 'too_large');
      assert.match(error.message, /1 MB native messaging limit/);
      return true;
    });
    assert.deepEqual(await env.host.send('ping'), { type: 'pong', protocol: 20 }, 'the pipe survives');
  });
});

test('closing the panel ends the host', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.hello');
    env.host.endStdin();
    await waitFor(() => env.host.exited, { what: 'the host to exit' });
    assert.equal(env.host.exited.code, 0);
  });
});

test('the fake Herdr speaks the protocol the host expects', async () => {
  await withEnv(async (env) => {
    // One request per connection: the server answers, then closes. Two calls on two
    // connections, exactly as host/bridge.mjs does it.
    assert.deepEqual(await herdrCall(env.herdr.socketPath, 'ping'), { type: 'pong', protocol: 20 });
    assert.deepEqual(await herdrCall(env.herdr.socketPath, 'agent.list'), { agents: [] });
  });
});
