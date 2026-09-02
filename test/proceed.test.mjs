// dia.proceed — the human has read the review and said what to do. The host clears the plan
// dialog, sends the instruction, and then answers Claude's own ceremony on their behalf:
// leaving plan mode, and the tool permission prompts that follow.

import test from 'node:test';
import assert from 'node:assert/strict';
import { withEnv } from './helpers.mjs';
import { scriptDialog } from './fake-herdr.mjs';

const PLAN_OPTIONS = ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'];

test('proceed dismisses the plan dialog, sends the instruction, then approves the exit', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked' });

    // Parked on the exit-plan dialog: the host picks "Tell Claude what to change" so the agent
    // comes back to its prompt without leaving plan mode.
    scriptDialog(agent, {
      options: PLAN_OPTIONS,
      onSelect(choice) {
        assert.equal(choice, 'Tell Claude what to change');
        agent.agent_status = 'idle';
        agent.screen = 'ready for your instruction';
      },
    });

    // The instruction arrives; Claude asks to leave plan mode for it.
    agent.onPrompt = () => {
      agent.agent_status = 'blocked';
      scriptDialog(agent, {
        options: PLAN_OPTIONS,
        selected: 2,
        onSelect(choice) {
          assert.equal(choice, 'Yes, and use auto mode');
          agent.agent_status = 'blocked';
          // Then an ordinary tool prompt.
          scriptDialog(agent, {
            header: 'Do you want to create review.md?',
            options: ['Yes', 'Yes, and switch to accept edits for this session', 'No, tell Claude what to do differently'],
            onSelect(inner) {
              assert.equal(inner, 'Yes, and switch to accept edits for this session');
              agent.agent_status = 'done';
              agent.screen = 'done';
            },
          });
        },
      });
    };

    const pending = env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'post it as a comment' }, { timeout: 90_000 });
    const result = await pending;

    assert.equal(result.type, 'proceeding');
    assert.equal(result.approved, true, 'it approved leaving plan mode');
    assert.equal(result.approvals, 1, 'and one tool prompt');
    assert.equal(agent.prompts.length, 1);
    assert.match(agent.prompts[0], /^post it as a comment\n/);
    assert.match(agent.prompts[0], /You have my approval to leave plan mode and act on this; do not ask me again\./);

    const progress = pending.progress.join('\n');
    assert.match(progress, /dismissed the plan dialog/);
    assert.match(progress, /instruction sent/);
    assert.match(progress, /approved leaving plan mode/);
    assert.match(progress, /approved: Do you want to create review\.md\?/);
  });
});

test('the dialog highlight is moved one key at a time, never coalesced', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'blocked' });
    scriptDialog(agent, {
      options: PLAN_OPTIONS,
      onSelect() { agent.agent_status = 'done'; agent.screen = 'dismissed'; },
    });
    agent.onPrompt = () => { agent.agent_status = 'done'; };

    await env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'go' }, { timeout: 90_000 });
    const sent = env.herdr.callsTo('agent.send_keys').map((c) => c.params.keys);
    assert.deepEqual(sent, [['down'], ['down'], ['enter']], 'from option 1 to option 3, then Enter alone');
  });
});

test('with no dialog up, proceed just sends the instruction', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle' });
    agent.onPrompt = () => { agent.agent_status = 'done'; };

    const pending = env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'apply the fixes' }, { timeout: 90_000 });
    const result = await pending;
    assert.equal(result.approved, false);
    assert.equal(result.approvals, 0);
    assert.deepEqual(env.herdr.callsTo('agent.send_keys'), []);
    assert.equal(agent.prompts.length, 1);
    assert.ok(!pending.progress.join('\n').includes('dismissed the plan dialog'));
  });
});

test('a question the host does not recognize is left for the human in Herdr', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle' });
    agent.onPrompt = () => {
      agent.agent_status = 'blocked';
      agent.screen = 'Which of these three approaches would you prefer?\n❯ 1. the first\n  2. the second';
    };

    const pending = env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'go' }, { timeout: 90_000 });
    const result = await pending;
    assert.equal(result.approved, false);
    assert.equal(result.approvals, 0);
    assert.match(pending.progress.join('\n'), /rv-7-herdr-dia-ab12 is waiting for input in Herdr/);
    assert.deepEqual(env.herdr.callsTo('agent.send_keys'), [], 'the host does not guess at an answer');
  });
});

test('a plain "Yes" is taken when there is no accept-edits option', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle' });
    agent.onPrompt = () => {
      agent.agent_status = 'blocked';
      scriptDialog(agent, {
        header: 'Do you want to run the tests?',
        options: ['Yes', 'No'],
        onSelect(choice) {
          assert.equal(choice, 'Yes');
          agent.agent_status = 'done';
        },
      });
    };
    const result = await env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'go' }, { timeout: 90_000 });
    assert.equal(result.approvals, 1);
  });
});

test('proceed needs both an agent and something to say', async () => {
  await withEnv(async (env) => {
    await assert.rejects(env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12' }), /proceed needs the agent name and an instruction/);
    await assert.rejects(env.host.send('dia.proceed', { text: '   ' }), /proceed needs the agent name and an instruction/);
    assert.deepEqual(env.herdr.calls, []);
  });
});

test('proceed on an agent that has gone away stops instead of hanging', async () => {
  await withEnv(async (env) => {
    const agent = env.herdr.addAgent({ name: 'rv-7-herdr-dia-ab12', agent_status: 'idle' });
    agent.onPrompt = () => { env.herdr.state.agents.delete('rv-7-herdr-dia-ab12'); };
    const result = await env.host.send('dia.proceed', { name: 'rv-7-herdr-dia-ab12', text: 'go' }, { timeout: 90_000 });
    assert.equal(result.type, 'proceeding');
    assert.equal(result.approved, false);
  });
});
