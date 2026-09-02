// dia.launch, review mode — one workspace called herdr-dia, a tab per PR in the checkout, a
// plan-mode agent, and the review brief. Nothing here is allowed to write to the PR.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { withEnv, initRepo, waitFor } from './helpers.mjs';
import { notification } from './fixtures/github.mjs';

const PR = { owner: 'rewt', repo: 'herdr-dia', number: 7, url: 'https://github.com/rewt/herdr-dia/pull/7', title: 'Add tests' };

test('a review lands as a tab in the herdr-dia workspace, in the checkout', async () => {
  await withEnv(async (env) => {
    const checkout = initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });

    assert.equal(launched.type, 'launched');
    assert.equal(launched.mode, 'review');
    assert.equal(launched.existing, true);
    assert.equal(launched.cwd, checkout, 'a review runs in the checkout, read-only');
    assert.deepEqual(env.herdr.workspaceLabels(), ['herdr-dia']);
    assert.deepEqual(env.herdr.tabLabels(), ['herdr-dia#7 review']);
    assert.equal(env.herdr.state.tabs.get(launched.workspace_id ? [...env.herdr.state.tabs.keys()][0] : '').cwd, checkout);
    assert.ok(launched.resultFile.endsWith(path.join('.herdr-dia', 'reviews', 'rewt', 'herdr-dia', '7.json')));
  });
});

test('the reviewer is started in plan mode and gets the read-only brief', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', instruction: 'watch the error paths', reposRoot: env.repos }, { timeout: 60_000 });

    assert.equal(launched.planMode, true);
    assert.match(launched.name, /^rv-7-herdr-dia-[0-9a-z]{4}$/);
    const agent = env.herdr.agent(launched.name);
    assert.deepEqual(agent.args, ['--permission-mode', 'plan']);
    assert.equal(agent.agent, 'claude');
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /You are in plan mode: read and analyze only/);
    assert.match(agent.prompts[0], /Focus: watch the error paths/);
    assert.match(agent.prompts[0], /rewt\/herdr-dia#7 — "Add tests"/);
  });
});

test('the empty root tab Herdr leaves behind is swept away', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    assert.deepEqual(env.herdr.tabLabels(), ['herdr-dia#7 review'], 'the bare-numbered shell tab is gone');
    assert.equal(env.herdr.callsTo('tab.close').length, 1);
  });
});

test('a second review reuses the workspace instead of making another', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    initRepo(path.join(env.repos, 'other-repo'), { origin: 'git@github.com:rewt/other-repo.git' });
    await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    await env.host.send('dia.launch', { owner: 'rewt', repo: 'other-repo', number: 12, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });

    assert.equal(env.herdr.callsTo('workspace.create').length, 1, 'discovered by label from the snapshot');
    assert.deepEqual(env.herdr.tabLabels().sort(), ['herdr-dia#7 review', 'other-repo#12 review']);
    assert.equal(env.herdr.state.agents.size, 2);
  });
});

test('the launch is remembered as a session, with the PR context', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });

    const session = env.sessionsRegistry()[launched.name];
    assert.equal(session.owner, 'rewt');
    assert.equal(session.repo, 'herdr-dia');
    assert.equal(session.number, 7);
    assert.equal(session.mode, 'review');
    assert.equal(session.planMode, true);
    assert.equal(session.title, 'Add tests');
    assert.equal(session.url, PR.url);
    assert.equal(session.workspaceId, launched.workspace_id);
    assert.ok(session.tabId);
    assert.ok(Date.parse(session.createdAt) > 0);
  });
});

test('identities travel with the workspace, and direnv is neutralized', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos, ghConfigDir: '~/.config/gh-work', claudeConfigDir: '~/.claude-personal' }, { timeout: 60_000 });

    const env2 = env.herdr.lastCall('tab.create').params.env;
    assert.equal(env2.GH_CONFIG_DIR, `${env.home}/.config/gh-work`);
    assert.equal(env2.CLAUDE_CONFIG_DIR, `${env.home}/.claude-personal`);
    assert.equal(env2.GH_IDENTITY_QUIET, '1');
    // The Herdr server inherits direnv's state; clearing it stops a pane in a directory with
    // no .envrc from "unloading" the identities we just set.
    assert.deepEqual([env2.DIRENV_DIFF, env2.DIRENV_DIR, env2.DIRENV_FILE, env2.DIRENV_WATCHES], ['', '', '', '']);
    assert.deepEqual(env.herdr.lastCall('workspace.create').params.env, env2);
  });
});

test('an agent kind without plan mode gets the posting brief instead', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', kind: 'codex', reposRoot: env.repos }, { timeout: 60_000 });

    assert.equal(launched.planMode, false);
    assert.deepEqual(env.herdr.agent(launched.name).args, []);
    const brief = env.herdr.agent(launched.name).prompts[0];
    assert.match(brief, /gh pr review 7 --repo rewt\/herdr-dia --comment --body-file review\.md/);
    assert.match(brief, new RegExp(`HERDR_DIA_RESULT ${launched.resultFile.replace(/[/.]/g, '\\$&')}`));
  });
});

test('planMode: false asks for the posting brief even from Claude', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', planMode: false, reposRoot: env.repos }, { timeout: 60_000 });
    assert.equal(launched.planMode, false);
    assert.match(env.herdr.agent(launched.name).prompts[0], /Post the review as a comment/);
  });
});

test('dispatching from the brief marks the notification read', async () => {
  const scenario = { notifications: [notification({ number: 7, id: 'thread-9' })] };
  await withEnv({ scenario }, async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    await env.host.send('dia.launch', { ...PR, mode: 'review', threadId: 'thread-9', reposRoot: env.repos }, { timeout: 60_000 });
    const patch = env.ghCallsMatching(/notifications\/threads/);
    assert.equal(patch.length, 1);
    assert.deepEqual(patch[0].argv, ['api', '-X', 'PATCH', 'notifications/threads/thread-9']);
  });
});

test('a pane that is still starting up is retried, not surfaced', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    env.herdr.failNext('agent.start', 'agent_pane_busy', 'the pane is busy', 2);
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    assert.equal(env.herdr.callsTo('agent.start').length, 3, 'two failures, then the real start');
    assert.ok(env.herdr.agent(launched.name));
  });
});

test('any other agent.start failure is reported to the panel', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    env.herdr.failNext('agent.start', 'agent_kind_unknown', 'no such agent kind');
    await assert.rejects(
      env.host.send('dia.launch', { ...PR, mode: 'review', kind: 'nope', reposRoot: env.repos }, { timeout: 60_000 }),
      (error) => error.herdr.code === 'agent_kind_unknown',
    );
    assert.equal(env.herdr.callsTo('agent.start').length, 1, 'not retried');
  });
});

test('the folder-trust dialog is answered with Down then Enter, separately', async () => {
  const herdr = {
    startStatus: 'blocked',
    startScreen: 'Do you trust the files in this folder?\n  Yes, I trust this folder\n❯ No, exit\n',
    onAgentStart(agent) {
      // Claude Code reads Down+Enter arriving as one chunk as an Escape, so the host sends
      // them apart and re-reads in between; the fake only moves when it is asked to.
      agent.onKeys = (keys) => {
        if (keys.includes('down')) agent.screen = 'Do you trust the files in this folder?\n❯ Yes, I trust this folder\n  No, exit\n';
        if (keys.includes('enter')) { agent.screen = 'ready'; agent.agent_status = 'idle'; }
      };
    },
  };
  await withEnv({ herdr }, async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const launched = await env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    const agent = env.herdr.agent(launched.name);
    assert.deepEqual(agent.keys, ['down', 'enter']);
    assert.equal(agent.prompts.length, 1, 'the brief follows once the folder is trusted');
    const keyCalls = env.herdr.callsTo('agent.send_keys');
    assert.deepEqual(keyCalls.map((c) => c.params.keys), [['down'], ['enter']], 'never coalesced');
  });
});

test('launch reports its progress as it goes', async () => {
  await withEnv(async (env) => {
    initRepo(path.join(env.repos, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
    const pending = env.host.send('dia.launch', { ...PR, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    await pending;
    const text = pending.progress.join('\n');
    assert.match(text, /tab in herdr-dia/);
    assert.match(text, /starting claude as rv-7-herdr-dia-\w{4} \(plan mode\)/);
    assert.match(text, /sending the review brief/);
  });
});

test('launch refuses a request that is missing the PR', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.launch', { owner: 'rewt', mode: 'review' }), /launch needs owner, repo and number/);
    assert.deepEqual(env.herdr.calls, [], 'nothing was created');
  });
});

test('a repo with no checkout under the root still gets a tab, ready to clone into', async () => {
  await withEnv(async (env) => {
    const launched = await env.host.send('dia.launch', { owner: 'rewt', repo: 'not-cloned', number: 3, mode: 'review', reposRoot: env.repos }, { timeout: 60_000 });
    assert.equal(launched.existing, false);
    assert.equal(launched.cwd, path.join(env.repos, 'not-cloned'));
    await waitFor(() => env.herdr.tabLabels().includes('not-cloned#3 review'), { what: 'the review tab' });
  });
});
