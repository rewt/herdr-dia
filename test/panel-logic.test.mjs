// The panel's decisions, without a browser: what a status means, when a merge button is
// live, when the queue is worth re-rendering, and how a GitHub tab becomes a PR.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REASONS, SESSION_ORDER, IDLE_READY_MS, idleSince, settled, sessionReady, sessionStatusWord,
  queueSignature, agentSlug, PR_RE, parsePrUrl, cleanTitle, shortPath, approvalState, mergeState,
  fixInstruction,
} from '../extension/logic.js';

test('settled: done is ready, and a blocked plan-mode reviewer is ready too', () => {
  assert.equal(settled(null), false);
  assert.equal(settled({ name: 'a', status: 'done' }), true);
  assert.equal(settled({ name: 'b', status: 'blocked', mode: 'review' }), true, 'parked on the exit-plan dialog');
  assert.equal(settled({ name: 'c', status: 'blocked', mode: 'implement' }), false, 'an update needs a human');
  assert.equal(settled({ name: 'd', status: 'working' }), false);
});

test('settled: idle only counts once it has held for the debounce window', () => {
  idleSince.clear();
  const t0 = 1_000_000;
  const agent = { name: 'flicker', status: 'idle', mode: 'review' };
  assert.equal(settled(agent, t0), false, 'first idle poll starts the clock');
  assert.equal(settled(agent, t0 + IDLE_READY_MS - 1), false);
  assert.equal(settled(agent, t0 + IDLE_READY_MS), true);
});

test('settled: a flicker back to working resets the idle clock', () => {
  idleSince.clear();
  const t0 = 2_000_000;
  settled({ name: 'flicker2', status: 'idle', mode: 'review' }, t0);
  assert.equal(settled({ name: 'flicker2', status: 'working', mode: 'review' }, t0 + 10_000), false);
  assert.equal(settled({ name: 'flicker2', status: 'idle', mode: 'review' }, t0 + 20_000), false, 'clock restarted');
  assert.equal(settled({ name: 'flicker2', status: 'idle', mode: 'review' }, t0 + 20_000 + IDLE_READY_MS), true);
});

test('sessionReady is only ever true for a review', () => {
  idleSince.clear();
  assert.equal(sessionReady({ agentName: 'rv-1-x-aaaa', mode: 'review', status: 'blocked' }), true);
  assert.equal(sessionReady({ agentName: 'pr-1-x-aaaa', mode: 'implement', status: 'done' }), false);
});

test('sessionStatusWord speaks the board’s language for every status', () => {
  idleSince.clear();
  const review = (status) => sessionStatusWord({ agentName: `rv-${status}`, mode: 'review', status });
  const update = (status) => sessionStatusWord({ agentName: `pr-${status}`, mode: 'implement', status });
  assert.equal(review('blocked'), 'review ready');
  assert.equal(review('done'), 'review ready');
  assert.equal(review('working'), 'reviewing…');
  assert.equal(review('idle'), 'reviewing…', 'a freshly idle reviewer is still working');
  assert.equal(review('gone'), 'finished');
  assert.equal(update('working'), 'updating…');
  assert.equal(update('blocked'), 'needs you');
  assert.equal(update('done'), 'done');
  assert.equal(update('gone'), 'finished');
  assert.equal(update('some-new-status'), 'some-new-status');
});

test('the board sorts whoever needs a human first', () => {
  assert.ok(SESSION_ORDER.blocked < SESSION_ORDER.working);
  assert.ok(SESSION_ORDER.working < SESSION_ORDER.idle);
  assert.ok(SESSION_ORDER.done < SESSION_ORDER.gone);
});

// ---------------------------------------------------------------- queue signature
const tiersOf = (over = {}) => ({
  favorites: [], mine: [], brief: [], team: [], other: [],
  ...over,
});
const pr = (over = {}) => ({ owner: 'rewt', repo: 'herdr-dia', number: 7, ...over });

test('queueSignature is stable when nothing meaningful changed', () => {
  const a = tiersOf({ mine: [pr({ title: 'one' })] });
  const b = tiersOf({ mine: [pr({ title: 'a different title, same state' })] });
  assert.equal(queueSignature(a), queueSignature(b));
});

test('queueSignature changes when approval, mergeability, agent status or result changes', () => {
  const base = tiersOf({ mine: [pr()] });
  const sig = queueSignature(base);
  assert.notEqual(queueSignature(tiersOf({ mine: [pr({ reviewDecision: 'APPROVED' })] })), sig);
  assert.notEqual(queueSignature(tiersOf({ mine: [pr({ mergeable: 'MERGEABLE' })] })), sig);
  assert.notEqual(queueSignature(tiersOf({ mine: [pr({ agent: { status: 'working' } })] })), sig);
  assert.notEqual(queueSignature(tiersOf({ mine: [pr({ result: { summary: 'x' } })] })), sig);
  assert.notEqual(queueSignature(tiersOf({ brief: [pr()] })), sig, 'the tier a PR sits in matters');
});

test('queueSignature tolerates missing tiers', () => {
  assert.equal(queueSignature({}), queueSignature(tiersOf()));
});

// ---------------------------------------------------------------- rows
test('agentSlug matches the host so a session row maps to its agent', () => {
  assert.equal(agentSlug('example-repository-name'), 'example-repository-name');
  assert.equal(agentSlug(undefined), '');
  assert.equal(agentSlug(null), '');
});

test('the reasons a PR reached the brief are spelled out', () => {
  assert.equal(REASONS.review_requested, 'review requested');
  assert.equal(REASONS.author, 'your PR');
  assert.equal(REASONS.ci_activity, 'CI');
});

test('PR_RE / parsePrUrl recognize a pull request tab and nothing else', () => {
  const parsed = parsePrUrl('https://github.com/rewt/herdr-dia/pull/12/files', 'Add tests by rewt · Pull Request #12 · rewt/herdr-dia');
  assert.deepEqual(parsed, {
    owner: 'rewt', repo: 'herdr-dia', number: 12,
    url: 'https://github.com/rewt/herdr-dia/pull/12', title: 'Add tests',
  });
  assert.equal(parsePrUrl('https://github.com/rewt/herdr-dia/issues/12'), null);
  assert.equal(parsePrUrl('https://example.com/rewt/herdr-dia/pull/12'), null);
  assert.equal(parsePrUrl(undefined), null);
  assert.ok(PR_RE.test('https://github.com/a/b/pull/1'));
});

test('cleanTitle strips GitHub’s tab-title furniture', () => {
  assert.equal(cleanTitle('Fix the thing by someone · Pull Request #4 · org/repo'), 'Fix the thing');
  assert.equal(cleanTitle('rewt/herdr-dia · GitHub'), 'rewt/herdr-dia');
  assert.equal(cleanTitle(), '');
});

test('shortPath abbreviates the home directory', () => {
  assert.equal(shortPath('/Users/someone/development/x'), '~/development/x');
  assert.equal(shortPath('/opt/other'), '/opt/other');
  assert.equal(shortPath(null), '');
});

// ---------------------------------------------------------------- your own PRs
test('approvalState only speaks for PRs that carry a review decision', () => {
  assert.equal(approvalState({}), null, 'queue PRs have no badge');
  assert.deepEqual(approvalState({ reviewDecision: 'APPROVED' }), { cls: 'ok', text: '✓ approved' });
  assert.deepEqual(approvalState({ reviewDecision: 'CHANGES_REQUESTED' }), { cls: 'changes', text: '± changes requested' });
  assert.deepEqual(approvalState({ reviewDecision: null }), { cls: 'pending', text: 'review pending' });
});

test('merge is live only when the PR is approved and mergeable', () => {
  assert.deepEqual(mergeState({ reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }), { enabled: true, title: '' });
  assert.equal(mergeState({ reviewDecision: null, mergeable: 'MERGEABLE' }).enabled, false);
  assert.equal(mergeState({ reviewDecision: null, mergeable: 'MERGEABLE' }).title, 'waiting for approval');
  assert.equal(mergeState({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' }).title, 'not mergeable (conflicting)');
  assert.equal(mergeState({ reviewDecision: 'APPROVED', mergeable: null }).title, 'not mergeable (unknown)');
});

test('fixInstruction turns a review into a task list', () => {
  const instruction = fixInstruction({
    comment_url: 'https://github.com/rewt/herdr-dia/pull/7#issuecomment-1',
    findings: [
      { severity: 'high', file: 'host/bridge.mjs', line: 42, title: 'unchecked input', suggestion: 'validate it' },
      { severity: 'low', title: 'naming' },
    ],
  });
  assert.match(instruction, /^Address these findings from the agent review:$/m);
  assert.match(instruction, /^- \[high\] host\/bridge\.mjs:42 — unchecked input: validate it$/m);
  assert.match(instruction, /^- \[low\] naming$/m);
  assert.match(instruction, /The full review is at https:/);
});

test('fixInstruction copes with a result that has no findings and no comment', () => {
  assert.equal(fixInstruction({}), 'Address these findings from the agent review:');
});
