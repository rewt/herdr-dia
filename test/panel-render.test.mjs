// The panel itself, booted in Node against a stub DOM and a stub native-messaging port: the
// rendering code that turns a dia.queue answer into rows, badges and buttons. It is one boot
// per file (importing panel.js runs it), so the assertions share the panel and read it back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelDom, find, findAll, byText, byClass } from './fake-dom.mjs';

const queueAnswer = {
  type: 'queue',
  root: '/tmp/repos',
  favorites: [],
  mine: [
    { owner: 'rewt', repo: 'herdr-dia', number: 40, title: 'Ready to go', url: 'https://github.com/rewt/herdr-dia/pull/40', author: 'rewt', updatedAt: '2026-09-01T13:00:00Z', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', result: null, agent: null },
    { owner: 'rewt', repo: 'herdr-dia', number: 41, title: 'Still waiting', url: 'https://github.com/rewt/herdr-dia/pull/41', author: 'rewt', updatedAt: '2026-09-01T12:00:00Z', reviewDecision: null, mergeable: 'MERGEABLE', result: null, agent: null },
  ],
  brief: [
    { owner: 'rewt', repo: 'herdr-dia', number: 1, title: 'Please look', url: 'https://github.com/rewt/herdr-dia/pull/1', author: 'alice', reason: 'review_requested', threadId: 'th-1', updatedAt: '2026-09-01T11:00:00Z', result: null, agent: null },
  ],
  team: [],
  other: [],
  prs: [],
  knownRepos: ['herdr-dia'],
  knownAuthors: ['alice'],
  onlyUnapproved: true,
  mineState: 'open',
  repoFilterActive: false,
};

const sessionsAnswer = {
  type: 'sessions',
  sessions: [{
    agentName: 'rv-1-herdr-dia-ab12', owner: 'rewt', repo: 'herdr-dia', number: 1, mode: 'review',
    url: 'https://github.com/rewt/herdr-dia/pull/1', title: 'Please look', status: 'blocked',
    paneId: 'p1', result: null, createdAt: '2026-09-01T11:30:00Z',
  }],
};

const merges = [];
const panel = installPanelDom({
  tab: { url: 'https://github.com/rewt/herdr-dia/pull/40/files', title: 'Ready to go by rewt · Pull Request #40 · rewt/herdr-dia' },
  handlers: {
    'dia.hello': () => ({ type: 'hello', socket: '/Users/someone/.config/herdr/herdr.sock', home: '/Users/someone', pid: 1, defaultRoot: '~/herdr-dia' }),
    'dia.config': () => ({ type: 'config', identities: [{ dir: '/Users/someone/.config/gh-work', name: 'gh-work', account: 'acme-dev', isDefault: false }], agents: [{ kind: 'claude', version: '1' }, { kind: 'codex', version: '1' }], claudeConfigs: [], defaultRoot: '~/herdr-dia' }),
    'dia.queue': () => queueAnswer,
    'dia.sessions': () => sessionsAnswer,
    'dia.subscribe': () => ({ type: 'subscribed', count: 0 }),
    'agent.list': () => ({ agents: [{ name: 'rv-1-herdr-dia-ab12', agent: 'claude', agent_status: 'blocked', pane_id: 'p1' }] }),
    'dia.merge_pr': (params) => { merges.push(params); return { type: 'merged', method: 'squash' }; },
  },
});

await import('../extension/panel.js');
await panel.settle();

const queueRoot = () => panel.el('queue');
const tabButton = (label) => find(queueRoot(), (el) => el.tagName === 'BUTTON' && el.classList.contains('tab') && el.textContent.startsWith(label));
const rowFor = (number) => findAll(queueRoot(), (el) => el.classList.contains('pr')).find((row) => row.textContent.includes(`#${number}`));

test('the panel connects and reports the socket it reached', () => {
  assert.equal(panel.el('conn').className, 'conn ok');
  assert.equal(panel.el('conn').textContent, '~/.config/herdr/herdr.sock', 'home is abbreviated');
  assert.equal(panel.requestsFor('dia.hello').length, 1);
});

test('the active tab becomes the This-tab card', () => {
  assert.equal(panel.el('pr-ref').textContent, 'rewt/herdr-dia#40');
  assert.equal(panel.el('pr-title').textContent, 'Ready to go', 'GitHub’s title furniture is stripped');
  assert.equal(panel.el('review').disabled, false);
  assert.equal(panel.el('launch').disabled, false);
});

test('the queue renders a tab per tier, with counts', () => {
  const tabs = findAll(queueRoot(), (el) => el.classList.contains('tab'));
  // Empty tiers get no tab — except the one you are on, so the panel never moves the ground
  // under you when a tier momentarily empties.
  assert.deepEqual(tabs.map((t) => t.textContent.trim()), ['Favorites 0', 'Mine 2', 'Brief 1']);
  assert.ok(tabs[0].classList.contains('active'), 'Favorites is where the queue opens');
  assert.match(queueRoot().textContent, /No Favorites right now./);
});

test('a PR row carries its reference, author and reason', () => {
  tabButton('Brief').dispatch('click');
  const row = rowFor(1);
  assert.ok(row, 'the brief PR is rendered');
  assert.match(row.textContent, /rewt\/herdr-dia#1 · alice · review requested/);
  assert.match(row.textContent, /Please look/);
});

test('your own approved PR shows the badge and an armed-on-second-click Merge', async () => {
  tabButton('Mine').dispatch('click');
  const row = rowFor(40);
  assert.equal(byClass(row, 'approval')[0].textContent, '✓ approved');
  assert.ok(byClass(row, 'approval')[0].classList.contains('ok'));

  const merge = find(row, (el) => el.classList.contains('merge'));
  assert.equal(merge.disabled, false, 'approved and mergeable');
  assert.equal(merge.textContent, 'Merge');

  merge.dispatch('click'); // arms, does not merge
  assert.deepEqual(merges, [], 'one click is never enough');
  const armed = find(rowFor(40), (el) => el.classList.contains('merge'));
  assert.equal(armed.textContent, 'Confirm merge');

  armed.dispatch('click');
  await panel.settle();
  assert.deepEqual(merges, [{ owner: 'rewt', repo: 'herdr-dia', number: 40, ghConfigDir: undefined }]);
  assert.match(panel.el('progress').textContent, /merged rewt\/herdr-dia#40 \(squash\)/);
});

test('a PR still waiting for review cannot be merged', () => {
  tabButton('Mine').dispatch('click');
  const row = rowFor(41);
  assert.equal(byClass(row, 'approval')[0].textContent, 'review pending');
  const merge = find(row, (el) => el.classList.contains('merge'));
  assert.equal(merge.disabled, true);
  assert.equal(merge.title, 'waiting for approval');
});

test('the Mine tier offers the Open/Closed switch', () => {
  tabButton('Mine').dispatch('click');
  const toggle = find(queueRoot(), (el) => el.classList.contains('mine-toggle'));
  assert.deepEqual(toggle.children.map((b) => b.textContent), ['Open', 'Closed']);
  assert.ok(toggle.children[0].classList.contains('active'));
});

test('the Active board shows the session, and a finished review reads as ready', () => {
  const board = panel.el('agents');
  assert.equal(panel.el('active-card').hidden, false);
  assert.equal(panel.el('agent-count').textContent, '· 1');
  assert.match(board.textContent, /herdr-dia#1/);
  assert.match(board.textContent, /review · review ready/, 'blocked on the exit-plan dialog means the review is ready');
  assert.ok(byText(board, 'Read review'), 'and its review can be opened');
  assert.ok(byText(board, 'End'), 'a live session can be ended');
});

test('a status event repaints the board without a round trip', () => {
  const before = panel.requests.length;
  panel.emit({ subscription: 'p1', event: 'pane.agent_status_changed', data: { pane_id: 'p1', agent_status: 'working' } });
  assert.match(panel.el('agents').textContent, /review · reviewing…/);
  assert.equal(panel.requests.length, before, 'the local agent list is enough');
});

test('the settings sheet is populated from what this machine actually has', async () => {
  panel.el('gear').dispatch('click');
  await panel.settle();
  assert.equal(panel.el('settings').hidden, false);
  assert.deepEqual(panel.el('gh-config').children.map((o) => o.textContent), ['Default (gh)', 'acme-dev · gh-work']);
  assert.deepEqual(panel.el('kind').children.map((o) => o.textContent), ['claude · 1', 'codex · 1']);
  assert.deepEqual(byClass(panel.el('repos'), 'chip').map((c) => c.textContent), ['herdr-dia']);
  assert.deepEqual(byClass(panel.el('authors'), 'chip').map((c) => c.textContent), ['@alice']);
});
