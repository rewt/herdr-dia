// The first dia.queue of a session. It has to carry the settings saved in the panel's storage:
// asked with the defaults it uses the wrong GitHub identity and no favorites, and that answer
// stands on screen until the 20s tick finally replaces it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelDom, find, findAll } from './fake-dom.mjs';

const pr = (number, title) => ({
  owner: 'rewt', repo: 'herdr-dia', number, title, url: `https://github.com/rewt/herdr-dia/pull/${number}`,
  author: 'rewt', updatedAt: '2026-09-01T13:00:00Z', reviewDecision: 'APPROVED', mergeable: 'MERGEABLE',
  result: null, agent: null,
});

const remembered = {
  at: Date.now(), mineState: 'open',
  tiers: { favorites: [], mine: [pr(7, 'Remembered from last time')], brief: [], team: [], other: [] },
};

const panel = installPanelDom({
  tab: null,
  storage: {
    ghConfigDir: '/Users/someone/.config/gh-work',
    favorites: ['alice'],
    repos: ['herdr-dia'],
    onlyUnapproved: false,
    mineState: 'open',
    queueCache: remembered,
  },
  handlers: {
    'dia.hello': () => ({ type: 'hello', socket: '/Users/someone/.config/herdr/herdr.sock', home: '/Users/someone', pid: 1, defaultRoot: '~/herdr-dia' }),
    'dia.config': () => ({ type: 'config', identities: [], agents: [{ kind: 'claude', version: '1' }], claudeConfigs: [], defaultRoot: '~/herdr-dia' }),
    'dia.queue': () => ({
      type: 'queue', root: '/tmp/repos', favorites: [], mine: [pr(8, 'Straight from GitHub')],
      brief: [], team: [], other: [], prs: [], knownRepos: ['herdr-dia'], knownAuthors: [],
      onlyUnapproved: false, mineState: 'open', repoFilterActive: true,
    }),
    'dia.sessions': () => ({ type: 'sessions', sessions: [] }),
    'dia.subscribe': () => ({ type: 'subscribed', count: 0 }),
    'agent.list': () => ({ agents: [] }),
  },
});

await import('../extension/panel.js');
await panel.settle();

const queueRoot = () => panel.el('queue');
const rowFor = (n) => findAll(queueRoot(), (el) => el.classList.contains('pr')).find((r) => r.textContent.includes(`#${n}`));

test('the first queue carries the saved settings, not the defaults', () => {
  const first = panel.requestsFor('dia.queue')[0];
  assert.ok(first, 'a queue was actually asked for');
  assert.equal(first.params.ghConfigDir, '/Users/someone/.config/gh-work', 'the saved GitHub identity');
  assert.deepEqual(first.params.favorites, ['alice'], 'the saved favorites — or the tier comes back empty');
  assert.deepEqual(first.params.repos, ['herdr-dia'], 'the saved repo filter');
  assert.equal(first.params.onlyUnapproved, false, 'the saved unapproved toggle');
});

test('the real answer replaces the remembered one and re-arms Merge', () => {
  assert.ok(rowFor(8), 'GitHub’s rows are in');
  assert.equal(rowFor(7), undefined, 'the remembered row is gone');
  const merge = find(rowFor(8), (el) => el.classList.contains('merge'));
  assert.equal(merge.disabled, false, 'a real answer can be merged from');
});
