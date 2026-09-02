// dia.subscribe — the one long-lived Herdr stream, relayed to the panel so agent status
// changes arrive without polling.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv, waitFor } from './helpers.mjs';

test('subscribing opens a stream and reports what it asked for', async () => {
  await withEnv(async (env) => {
    const result = await env.host.send('dia.subscribe', { subscriptions: [{ kind: 'agent_status' }, { kind: 'pane' }] });
    assert.deepEqual(result, { type: 'subscribed', count: 2 });
    await waitFor(() => env.herdr.streamCount() === 1, { what: 'the event stream' });
    assert.deepEqual(env.herdr.lastCall('events.subscribe').params.subscriptions, [{ kind: 'agent_status' }, { kind: 'pane' }]);
  });
});

test('events reach the panel tagged with the subscription that asked for them', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.subscribe', { subscriptions: [{ kind: 'agent_status' }] });
    await waitFor(() => env.herdr.streamCount() === 1, { what: 'the event stream' });

    env.herdr.push('pane.agent_status_changed', { pane_id: 'p1', agent_status: 'working' });
    env.herdr.push('pane_agent_detected', { pane_id: 'p1', agent: 'claude' });

    await waitFor(() => env.host.events.length === 2, { what: 'two events' });
    assert.deepEqual(env.host.events.map((e) => e.event), ['pane.agent_status_changed', 'pane_agent_detected']);
    assert.deepEqual(env.host.events[0].data, { pane_id: 'p1', agent_status: 'working' });
    assert.equal(env.host.events[0].subscription, 't1', 'tagged with the request that opened it');
  });
});

test('subscribing again replaces the stream rather than doubling it', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.subscribe', { subscriptions: [{ kind: 'agent_status' }] });
    await waitFor(() => env.herdr.streamCount() === 1, { what: 'the first stream' });
    await env.host.send('dia.subscribe', { subscriptions: [{ kind: 'pane' }] });
    await waitFor(() => env.herdr.streamCount() === 1 && env.herdr.callsTo('events.subscribe').length === 2, { what: 'the replacement stream' });

    env.herdr.push('pane.agent_status_changed', { pane_id: 'p1' });
    await waitFor(() => env.host.events.length === 1, { what: 'one copy of the event' });
    assert.equal(env.host.events.length, 1, 'not delivered twice');
  });
});

test('subscribing with nothing is allowed', async () => {
  await withEnv(async (env) => {
    assert.deepEqual(await env.host.send('dia.subscribe', {}), { type: 'subscribed', count: 0 });
  });
});

test('an error on the stream is passed through to the panel', async () => {
  await withEnv(async (env) => {
    await env.host.send('dia.subscribe', { subscriptions: [{ kind: 'agent_status' }] });
    await waitFor(() => env.herdr.streamCount() === 1, { what: 'the event stream' });
    for (const socket of env.herdr.streamSockets()) socket.write(`${JSON.stringify({ error: { code: 'subscription_lost', message: 'the pane went away' } })}\n`);
    await waitFor(() => env.host.events.length === 1, { what: 'the error' });
    assert.deepEqual(env.host.events[0].error, { code: 'subscription_lost', message: 'the pane went away' });
  });
});
