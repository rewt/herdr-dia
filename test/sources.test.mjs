// The invariants an agent editing this repo has to keep: everything parses, the extension is
// still loadable, the shared logic stays free of the DOM, and the versions agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const json = (...parts) => JSON.parse(read(...parts));

const sources = [
  'host/bridge.mjs', 'host/lib.mjs',
  'extension/panel.js', 'extension/logic.js', 'extension/background.js',
  'scripts/install.mjs', 'scripts/smoke.mjs', 'scripts/demo.mjs', 'scripts/screenshots.mjs',
  'docs/demo/fixtures.js',
  'test/helpers.mjs', 'test/fake-herdr.mjs', 'test/fake-dom.mjs', 'test/bin/gh',
];

test('every source file parses', () => {
  for (const file of sources) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
  }
});

test('the panel loads as a module, so it can import the shared logic', () => {
  const html = read('extension/panel.html');
  assert.match(html, /<script type="module" src="panel\.js"><\/script>/);
  assert.match(read('extension/panel.js'), /^import \{[\s\S]*?\} from '\.\/logic\.js';$/m);
});

test('the shared logic stays free of the DOM and chrome APIs', () => {
  const logic = read('extension/logic.js');
  for (const forbidden of ['document', 'chrome.', 'window.']) {
    assert.equal(logic.includes(forbidden), false, `logic.js must not reach for ${forbidden} — the tests import it directly`);
  }
});

test('the host and the panel agree on how an agent is named', async () => {
  const { agentSlug: hostSlug } = await import('../host/lib.mjs');
  const { agentSlug: panelSlug } = await import('../extension/logic.js');
  for (const repo of ['example-repository-name', 'acme-shared', 'herdr-dia', 'weird.name']) {
    assert.equal(panelSlug(repo), hostSlug(repo), `${repo} must slug the same on both sides`);
  }
});

test('the extension manifest is a loadable MV3 extension', () => {
  const manifest = json('extension/manifest.json');
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.key, 'the pinned key is what keeps the extension id stable');
  assert.deepEqual(manifest.permissions.sort(), ['nativeMessaging', 'sidePanel', 'storage', 'tabs']);
  assert.ok(fs.existsSync(path.join(ROOT, 'extension', manifest.side_panel.default_path)));
  assert.ok(fs.existsSync(path.join(ROOT, 'extension', manifest.background.service_worker)));
});

test('the package and the extension carry the same version', () => {
  assert.equal(json('package.json').version, json('extension/manifest.json').version);
});

test('npm test runs the suite', () => {
  assert.match(json('package.json').scripts.test, /node --test/);
});
