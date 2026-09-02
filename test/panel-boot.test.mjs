// The panel's first paint. Opening the side panel restarts the host, so its memo is cold and
// GitHub is a second away — but the queue the panel remembered last time needs no host at all.
// Here the host never answers, so what is on screen is purely what was restored from storage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installPanelDom, find, findAll } from './fake-dom.mjs';

const remembered = {
  at: Date.now(),
  mineState: 'open',
  tiers: {
    favorites: [],
    mine: [{
      owner: 'rewt', repo: 'herdr-dia', number: 7, title: 'Remembered from last time',
      url: 'https://github.com/rewt/herdr-dia/pull/7', author: 'rewt', updatedAt: '2026-09-01T13:00:00Z',
      reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', result: null, agent: null,
    }],
    brief: [], team: [], other: [],
  },
};

const panel = installPanelDom({
  tab: null,
  storage: { mineState: 'open', queueCache: remembered },
  // The host is up but thinking. Nothing it says can arrive, so nothing can overwrite the paint.
  handlers: { 'dia.hello': () => new Promise(() => {}) },
});

await import('../extension/panel.js');

const queueRoot = () => panel.el('queue');
const rowFor = (n) => findAll(queueRoot(), (el) => el.classList.contains('pr')).find((r) => r.textContent.includes(`#${n}`));

test('the remembered queue is on screen without the host having answered', () => {
  assert.equal(panel.requestsFor('dia.queue').length, 0, 'no queue has come back yet');
  assert.ok(rowFor(7), 'and yet there are rows to read');
  assert.match(queueRoot().textContent, /Remembered from last time/);
});

test('the queue opens on Mine', () => {
  const tabs = findAll(queueRoot(), (el) => el.classList.contains('tab'));
  assert.ok(tabs[0].classList.contains('active'));
  assert.equal(tabs[0].textContent.trim(), 'Mine 1');
});

test('nothing irreversible is offered off remembered rows', () => {
  const merge = find(rowFor(7), (el) => el.classList.contains('merge'));
  assert.equal(merge.disabled, true, 'approved and mergeable, but not from memory');
  assert.equal(merge.title, 'checking with GitHub…');
});
