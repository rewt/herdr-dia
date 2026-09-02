// dia.end_session / dia.dismiss_session — closing a session out for real (the tab, the agent
// in it, and the worktree if it is clean) versus just taking it off the board.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, initRepo, git, writeJson } from './helpers.mjs';

const session = (over = {}) => ({
  agentName: 'rv-7-herdr-dia-ab12', owner: 'rewt', repo: 'herdr-dia', number: 7, mode: 'review',
  url: 'https://github.com/rewt/herdr-dia/pull/7', title: 'Add tests', workspaceId: 'w1', tabId: null,
  createdAt: new Date().toISOString(), ...over,
});

test('ending a review closes its tab, which stops the agent, and forgets the session', async () => {
  await withEnv(async (env) => {
    const ws = await env.host.send('workspace.create', { cwd: env.home, label: 'herdr-dia' });
    const tab = await env.host.send('tab.create', { workspace_id: ws.workspace.workspace_id, cwd: env.home, label: 'herdr-dia#7 review' });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', tab_id: tab.tab.tab_id, pane_id: tab.root_pane.pane_id });
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ tabId: tab.tab.tab_id }) });

    const result = await env.host.send('dia.end_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.equal(result.type, 'session_ended');
    assert.equal(result.closedTab, tab.tab.tab_id);
    assert.equal(env.herdr.state.tabs.has(tab.tab.tab_id), false);
    assert.equal(env.herdr.agent('rv-7-herdr-dia-ab12'), null, 'the agent goes with its tab');
    assert.deepEqual(env.sessionsRegistry(), {});
  });
});

test('a reconstructed session with no recorded tab uses the agent’s own tab', async () => {
  await withEnv(async (env) => {
    const ws = await env.host.send('workspace.create', { cwd: env.home, label: 'herdr-dia' });
    const tab = await env.host.send('tab.create', { workspace_id: ws.workspace.workspace_id, cwd: env.home, label: 'herdr-dia#7 review' });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', tab_id: tab.tab.tab_id, pane_id: tab.root_pane.pane_id });
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ tabId: null }) });

    const result = await env.host.send('dia.end_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.equal(result.closedTab, tab.tab.tab_id);
  });
});

test('with no tab at all, the pane is closed instead', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', tab_id: null, pane_id: 'pane-9' });
    env.herdr.state.panes.set('pane-9', { pane_id: 'pane-9', tab_id: null, workspace_id: 'w1' });
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ tabId: null }) });

    const result = await env.host.send('dia.end_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.equal(result.closedTab, null);
    assert.equal(env.herdr.lastCall('pane.close').params.pane_id, 'pane-9');
    assert.deepEqual(env.sessionsRegistry(), {});
  });
});

test('ending an update also removes its clean worktree, keeping the branch', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { owner: 'rewt', repo: 'herdr-dia', number: 7, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });

    const result = await env.host.send('dia.end_session', { agentName: launched.name });
    assert.equal(result.type, 'session_ended');
    assert.equal(fs.existsSync(launched.cwd), false, 'the worktree directory is gone');
    assert.ok(git(['-C', checkout, 'branch', '--list', 'herdr-dia/pr-7']), 'the branch is kept');
    assert.deepEqual(env.worktreeRegistry(), {}, 'and it leaves the worktree list');
    assert.deepEqual(env.sessionsRegistry(), {});
    assert.deepEqual(env.herdr.tabLabels(), []);
  });
});

test('ending an update with uncommitted work leaves the worktree for the user to deal with', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { owner: 'rewt', repo: 'herdr-dia', number: 7, mode: 'implement', reposRoot: env.repos }, { timeout: 60_000 });
    fs.writeFileSync(path.join(launched.cwd, 'unsaved.txt'), 'half a fix\n');

    await env.host.send('dia.end_session', { agentName: launched.name });
    assert.ok(fs.existsSync(path.join(launched.cwd, 'unsaved.txt')), 'nothing is thrown away');
    assert.equal(Object.keys(env.worktreeRegistry()).length, 1, 'it stays in Worktrees settings');
    assert.deepEqual(env.sessionsRegistry(), {}, 'but the session is closed out');
  });
});

test('ending a session whose agent and tab are already gone still forgets it', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ tabId: 'a-tab-that-no-longer-exists' }) });
    const result = await env.host.send('dia.end_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.equal(result.type, 'session_ended');
    assert.deepEqual(env.sessionsRegistry(), {});
  });
});

test('end_session needs an agent name', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.end_session', {}), /end_session needs an agentName/);
  });
});

// ---------------------------------------------------------------- dismiss
test('dismissing a session forgets it and leaves the tab and agent alone', async () => {
  await withEnv(async (env) => {
    const ws = await env.host.send('workspace.create', { cwd: env.home, label: 'herdr-dia' });
    const tab = await env.host.send('tab.create', { workspace_id: ws.workspace.workspace_id, cwd: env.home, label: 'herdr-dia#7 review' });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', tab_id: tab.tab.tab_id });
    writeJson(env.statePath('sessions.json'), { 'rv-7-herdr-dia-ab12': session({ tabId: tab.tab.tab_id }) });

    const result = await env.host.send('dia.dismiss_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.deepEqual(result, { type: 'session_dismissed', agentName: 'rv-7-herdr-dia-ab12' });
    assert.deepEqual(env.sessionsRegistry(), {});
    assert.ok(env.herdr.state.tabs.has(tab.tab.tab_id), 'the tab is still open in Herdr');
    assert.ok(env.herdr.agent('rv-7-herdr-dia-ab12'), 'and the agent is still running');
    assert.deepEqual(env.herdr.callsTo('tab.close'), []);
  });
});

test('dismissing leaves the other sessions on the board', async () => {
  await withEnv(async (env) => {
    writeJson(env.statePath('sessions.json'), {
      'rv-7-herdr-dia-ab12': session(),
      'rv-8-herdr-dia-cd34': session({ agentName: 'rv-8-herdr-dia-cd34', number: 8 }),
    });
    await env.host.send('dia.dismiss_session', { agentName: 'rv-7-herdr-dia-ab12' });
    assert.deepEqual(Object.keys(env.sessionsRegistry()), ['rv-8-herdr-dia-cd34']);
  });
});

test('dismiss_session needs an agent name', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.dismiss_session', {}), /dismiss_session needs an agentName/);
  });
});
