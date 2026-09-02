// dia.review_text — reading the review back out of a plan-mode agent: from the plan file it
// wrote while parked on the exit-plan dialog, or from its scrollback once it is idle.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withEnv, writeJson } from './helpers.mjs';

const RESULT = '{"pr":"rewt/herdr-dia#7","summary":"one real problem","recommendation":"request-changes","findings":[{"severity":"high","file":"host/bridge.mjs","line":42,"title":"unchecked","suggestion":"validate"}]}';

function planScreen(planFile) {
  return [
    "Here is Claude's plan:",
    ' Review of rewt/herdr-dia#7 …',
    ` ctrl+g to edit in Nvim · ${planFile}`,
    ' Would you like to proceed?',
    '❯ 1. Yes, and use auto mode',
    '  2. Yes, manually approve edits',
    '  3. Tell Claude what to change',
  ].join('\n');
}

test('a parked reviewer is read from the plan file, without touching the dialog', async () => {
  await withEnv(async (env) => {
    const planFile = path.join(env.home, '.claude-personal', 'plans', 'review-pr-7.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `# Review of rewt/herdr-dia#7\n\nOne real problem.\n\nHERDR_DIA_RESULT ${RESULT}\n`);
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', screen: planScreen('~/.claude-personal/plans/review-pr-7.md') });

    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.source, 'plan-file');
    assert.equal(review.awaitingDecision, true, 'the agent is still parked, waiting for a decision');
    assert.equal(review.planFile, planFile);
    assert.match(review.text, /# Review of rewt\/herdr-dia#7/);
    assert.equal(review.result.summary, 'one real problem');
    assert.equal(review.result.findings[0].file, 'host/bridge.mjs');
    assert.deepEqual(env.herdr.callsTo('agent.send_keys'), [], 'reading a review must not answer the dialog');
  });
});

test('reading a review backfills the owner/repo a reconstructed session lacked', async () => {
  await withEnv(async (env) => {
    const planFile = path.join(env.home, '.claude-personal', 'plans', 'p.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `plan\nHERDR_DIA_RESULT ${RESULT}\n`);
    writeJson(env.statePath('sessions.json'), {
      'rv-7-herdr-dia-ab12': { agentName: 'rv-7-herdr-dia-ab12', owner: null, repo: 'herdr-dia', number: 7, mode: 'review', reconstructed: true, createdAt: new Date().toISOString() },
    });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', screen: planScreen('~/.claude-personal/plans/p.md') });

    await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    const healed = env.sessionsRegistry()['rv-7-herdr-dia-ab12'];
    assert.equal(healed.owner, 'rewt', 'Post as comment and Apply the fixes can work now');
    assert.equal(healed.repo, 'herdr-dia');
    assert.equal(healed.url, 'https://github.com/rewt/herdr-dia/pull/7');
  });
});

test('a session recorded with a real owner is never rewritten by a backfill', async () => {
  await withEnv(async (env) => {
    const planFile = path.join(env.home, '.claude-personal', 'plans', 'p.md');
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `plan\nHERDR_DIA_RESULT ${RESULT}\n`);
    writeJson(env.statePath('sessions.json'), {
      'rv-7-herdr-dia-ab12': { agentName: 'rv-7-herdr-dia-ab12', owner: 'someone-else', repo: 'their-repo', number: 7, mode: 'review', createdAt: new Date().toISOString() },
    });
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', screen: planScreen('~/.claude-personal/plans/p.md') });

    await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(env.sessionsRegistry()['rv-7-herdr-dia-ab12'].owner, 'someone-else');
  });
});

test('an idle reviewer is read from its scrollback, trimmed of the brief', async () => {
  await withEnv(async (env) => {
    const scrollback = [
      '> You are reviewing GitHub pull request rewt/herdr-dia#7 …',
      '─────────────',
      '⏺ I read the diff. One real problem:',
      '',
      '',
      '',
      '  host/bridge.mjs:42 — unchecked input',
      `HERDR_DIA_RESULT ${RESULT}`,
    ].join('\n');
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle', scrollback });

    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.source, 'pane');
    assert.equal(review.awaitingDecision, false);
    assert.ok(review.text.startsWith('⏺ I read the diff.'), review.text.slice(0, 40));
    assert.ok(!review.text.includes('You are reviewing GitHub pull request'), 'the brief is not the review');
    assert.ok(!/\n{3,}/.test(review.text), 'blank runs are collapsed');
    assert.equal(review.result.recommendation, 'request-changes');
    assert.equal(env.herdr.lastCall('agent.read').params.source, 'recent_unwrapped');
  });
});

test('an agent that is mid-turn falls back to what is on screen', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'working', notIdle: true, screen: `⏺ still going\nHERDR_DIA_RESULT ${RESULT}` });
    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.source, 'pane');
    assert.match(review.text, /still going/);
    assert.equal(review.result.summary, 'one real problem');
    assert.deepEqual(env.herdr.callsTo('agent.read').map((c) => c.params.source), ['recent_unwrapped', 'visible']);
  });
});

test('a review with no result line still returns its text', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle', scrollback: '⏺ I could not finish.' });
    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.result, null);
    assert.equal(review.text, '⏺ I could not finish.');
  });
});

test('a blocked agent that is not on the plan dialog is read from the pane', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', screen: 'Do you want to run this command?', scrollback: '⏺ waiting on you' });
    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.source, 'pane');
    assert.equal(review.awaitingDecision, false);
  });
});

test('a plan dialog whose file has vanished falls back to the pane', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked', screen: planScreen('~/.claude-personal/plans/gone.md'), scrollback: '⏺ the plan is on screen only' });
    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.source, 'pane');
    assert.match(review.text, /the plan is on screen only/);
  });
});

test('review_text reports a truncated read', async () => {
  await withEnv(async (env) => {
    env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle', scrollback: '⏺ long review', truncated: true });
    const review = await env.host.send('dia.review_text', { name: 'rv-7-herdr-dia-ab12' });
    assert.equal(review.truncated, true);
  });
});

test('review_text needs the agent name', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.review_text', {}), /review_text needs the agent name/);
  });
});
