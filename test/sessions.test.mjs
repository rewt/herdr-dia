// dia.sessions — the Active board: the registry of everything this extension launched, joined
// with the agents Herdr actually has running, and self-healing when the two disagree.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withEnv, initRepo, writeJson } from './helpers.mjs';
import { reviewResult } from './fixtures/github.mjs';

const session = (over = {}) => ({
  agentName: 'rv-7-herdr-dia-ab12', owner: 'rewt', repo: 'herdr-dia', number: 7, mode: 'review',
  url: 'https://github.com/rewt/herdr-dia/pull/7', title: 'Add tests', workspaceId: 'w1', tabId: 't2',
  createdAt: new Date().toISOString(), ...over,
});

test('a session carries its PR context and the live agent status', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session() });
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'working' });

    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'working');
    assert.equal(sessions[0].paneId, agent.pane_id);
    assert.equal(sessions[0].title, 'Add tests');
    assert.equal(sessions[0].number, 7);
  });
});

test('a session whose agent has exited reads as gone, and keeps its context', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session() });
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].status, 'gone');
    assert.equal(sessions[0].paneId, null);
    assert.equal(sessions[0].owner, 'rewt', 'still dismissible, still linkable');
  });
});

test('a finished session is forgotten after a day', async () => {
  await withEnv(async (env) => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    writeJson(env.statePath('sessions.json'), {
      'rv-7-herdr-dia-ab12': session({ createdAt: old }),
      'rv-8-herdr-dia-cd34': session({ agentName: 'rv-8-herdr-dia-cd34', number: 8, createdAt: new Date().toISOString() }),
    });
    const { sessions } = await env.host.send('dia.sessions');
    assert.deepEqual(sessions.map((s) => s.number), [8]);
    assert.deepEqual(Object.keys(env.sessionsRegistry()), ['rv-8-herdr-dia-cd34'], 'pruned from disk too');
  });
});

test('a still-running session is never pruned, however old', async () => {
  await withEnv(async (env) => {
    const old = new Date(Date.now() - 40 * 3600 * 1000).toISOString();
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ createdAt: old }) });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle' });
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions.length, 1);
  });
});

test('sessions come back newest first', async () => {
  await withEnv(async (env) => {
    // Relative to now: a session with no live agent is pruned once it is a day old, so fixed
    // dates make this test pass on the day it was written and fail every day after.
    const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    writeJson(env.statePath('sessions.json'), {
      older: session({ agentName: 'older', number: 1, createdAt: hoursAgo(4) }),
      newer: session({ agentName: 'newer', number: 2, createdAt: hoursAgo(2) }),
    });
    const { sessions } = await env.host.send('dia.sessions');
    assert.deepEqual(sessions.map((s) => s.agentName), ['newer', 'older']);
  });
});

test('a review session picks up the review file written for its PR', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session() });
    env.writeReviewResult('rewt', 'herdr-dia', 7, reviewResult({ number: 7, summary: 'one problem', findings: [{ severity: 'high', title: 'a' }] }));
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].result.summary, 'one problem');
  });
});

test('an update session never claims a review result', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'pr-7-herdr-dia-ab12': session({ agentName: 'pr-7-herdr-dia-ab12', mode: 'implement' }) });
    env.writeReviewResult('rewt', 'herdr-dia', 7, reviewResult({ number: 7 }));
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].result, null);
  });
});

// ---------------------------------------------------------------- self-heal
test('a live agent launched by an earlier host is reconstructed from its checkout', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', cwd: checkout, workspace_id: 'w9' });

    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].owner, 'rewt', 'owner comes from the git remote');
    assert.equal(sessions[0].repo, 'herdr-dia');
    assert.equal(sessions[0].number, 7);
    assert.equal(sessions[0].mode, 'review');
    assert.equal(sessions[0].url, 'https://github.com/rewt/herdr-dia/pull/7');
    assert.equal(sessions[0].reconstructed, true);
    assert.equal(sessions[0].workspaceId, 'w9');
    assert.ok(env.sessionsRegistry()['rv-7-herdr-dia-ab12'], 'and is persisted for next time');
  });
});

test('a plan-mode review in a bare directory reconstructs from its agent name alone', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-3064-ghec-c3-repos-fact-x9y8', agent_status: 'blocked', cwd: env.home });
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].owner, null, 'no git remote to learn it from — the review will fill it in');
    assert.equal(sessions[0].repo, 'ghec-c3-repos-fact');
    assert.equal(sessions[0].number, 3064);
    assert.equal(sessions[0].url, null);
    assert.equal(sessions[0].result, null);
  });
});

test('an update agent reconstructs as an update', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'https://github.com/rewt/herdr-dia' });
    env.herdr.addAgent({ name: 'pr-12-herdr-dia-ab12', agent_status: 'working', cwd: checkout });
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].mode, 'implement');
    assert.equal(sessions[0].number, 12);
  });
});

test('agents this extension did not launch are left alone', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'my-own-shell-agent', agent_status: 'idle' });
    env.herdr.addAgent({ name: 'rv-notanumber-repo-ab12', agent_status: 'idle' });
    const { sessions } = await env.host.send('dia.sessions');
    assert.deepEqual(sessions, []);
    assert.deepEqual(env.sessionsRegistry(), {});
  });
});

test('a recorded session is not overwritten by the self-heal', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ title: 'the real title' }) });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle', cwd: env.home });
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions[0].title, 'the real title');
    assert.equal(sessions[0].reconstructed, undefined);
  });
});

test('sessions survives Herdr being unreachable', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session() });
    await env.herdr.close();
    const { sessions } = await env.host.send('dia.sessions');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'gone');
  });
});
