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
  team: [
    { owner: 'rewt', repo: 'acme-platform', number: 30, title: 'Split the scheduler off the shared queue', url: 'https://github.com/rewt/acme-platform/pull/30', author: 'bob', updatedAt: '2026-09-01T10:00:00Z', result: null, agent: null },
    { owner: 'rewt', repo: 'acme-platform', number: 31, title: 'Rotate the enrolment keys', url: 'https://github.com/rewt/acme-platform/pull/31', author: 'alice', updatedAt: '2026-09-01T09:00:00Z', result: null, agent: null },
  ],
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

test('the queue opens on Mine, with a tab per tier and its count', () => {
  const tabs = findAll(queueRoot(), (el) => el.classList.contains('tab'));
  // Empty tiers get no tab — except the one you are on, so the panel never moves the ground
  // under you when a tier momentarily empties. Favorites is empty here and isn't the landing
  // tab, so it doesn't appear at all.
  assert.deepEqual(tabs.map((t) => t.textContent.trim()), ['Mine 2', 'Brief 1', 'Team 2']);
  assert.ok(tabs[0].classList.contains('active'), 'Mine is where the queue opens');
  assert.ok(rowFor(40), 'and it opens with your own PRs already on screen');
});

test('a PR row leads with the repository, then the number and title', () => {
  tabButton('Brief').dispatch('click');
  const row = rowFor(1);
  assert.ok(row, 'the brief PR is rendered');
  assert.equal(byClass(row, 'repo')[0].textContent, 'rewt/herdr-dia · review requested',
    'the repository leads, with the reason it reached you alongside');
  assert.equal(byClass(row, 'title-open')[0].textContent, '#1 Please look',
    'the number and title sit under it');
  assert.equal(row.textContent.includes('alice'), false, 'the author is not carried');
});

test('the title opens the pull request, without needing a PR button', () => {
  tabButton('Brief').dispatch('click');
  const before = panel.opened.length;
  byClass(rowFor(1), 'title-open')[0].dispatch('click');
  assert.deepEqual(panel.opened.slice(before), [{ url: 'https://github.com/rewt/herdr-dia/pull/1' }]);
  assert.equal(byText(rowFor(1), 'PR'), null, 'the redundant PR button is gone');
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

// Switching Mine between open and closed is a round-trip to GitHub. The segment still has to
// move under the finger, and the state you just left must not sit under the label you just
// picked. Everything here is read back synchronously, before the answer is allowed to land.
test('the Mine switch moves on the click, not on the answer', async () => {
  tabButton('Mine').dispatch('click');
  const toggle = () => find(queueRoot(), (el) => el.classList.contains('mine-toggle'));
  assert.ok(toggle().children[0].classList.contains('active'), 'starts on Open');

  const before = panel.requestsFor('dia.queue').length;
  toggle().children[1].dispatch('click');

  assert.ok(toggle().children[1].classList.contains('active'), 'Closed is lit before GitHub answers');
  assert.equal(toggle().children[0].classList.contains('active'), false, 'and Open has let go');
  assert.match(queueRoot().textContent, /loading…/, 'the open PRs are not shown under the closed label');
  assert.equal(rowFor(40), undefined, 'really not shown');
  assert.equal(panel.requestsFor('dia.queue').length, before + 1, 'one fetch, not one per repaint');

  await panel.settle();
  assert.ok(toggle().children[1].classList.contains('active'), 'and it stays put once the answer lands');
  assert.ok(rowFor(40), 'with the rows back');

  toggle().children[0].dispatch('click'); // back to Open, for whatever runs after this
  await panel.settle();
});

// Team is the one tier grouped by repository, so its heading already places every row under it.
test('a Team row does not repeat the repository its heading already gives', () => {
  tabButton('Team').dispatch('click');
  const heading = findAll(queueRoot(), (el) => el.classList.contains('tier-heading'))[0];
  assert.equal(heading.textContent, 'rewt/acme-platform');

  const row = rowFor(30);
  assert.equal(byClass(row, 'repo').length, 0, 'the row says it once, in the heading');
  assert.equal(byClass(row, 'title-open')[0].textContent, '#30 Split the scheduler off the shared queue');
});

// The queue's age and its refresh are one control: it says how old what you're reading is, and
// pressing it makes it current.
test('the freshness label doubles as the refresh button', async () => {
  const label = panel.el('queue-refresh');
  assert.equal(label.textContent, 'just now', 'a fresh answer reads as current');

  const before = panel.requestsFor('dia.queue').length;
  label.dispatch('click');
  assert.equal(label.textContent, 'checking…', 'it says so while it checks');
  assert.equal(label.disabled, true, 'and cannot be pressed twice');

  const asked = panel.requestsFor('dia.queue');
  assert.equal(asked.length, before + 1);
  assert.equal(asked[asked.length - 1].params.force, true, 'Refresh asks for a real fetch');

  await panel.settle();
  assert.equal(label.textContent, 'just now');
  assert.equal(label.disabled, false);
});

test('the dispatch button reads the same on your own PRs as on anyone else’s', () => {
  tabButton('Mine').dispatch('click');
  assert.ok(byText(rowFor(41), 'Review with an agent'), 'universal wording, no "on my behalf"');
  tabButton('Brief').dispatch('click');
  assert.ok(byText(rowFor(1), 'Review with an agent'));
});
