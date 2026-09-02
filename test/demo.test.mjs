// scripts/demo.mjs — the fixture demo the screenshots come from. It serves the real
// extension/panel.html with one injected script, so a change to how the panel loads must not
// silently stop the demo (and the screenshots) from working.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, waitFor } from './helpers.mjs';

async function withDemo(body) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs'), String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);
  try {
    await waitFor(async () => {
      try { await get('/'); return true; } catch { return false; }
    }, { what: 'the demo server', timeout: 10_000 });
    return await body(get);
  } finally {
    child.kill('SIGKILL');
  }
}

test('the demo serves the real panel with the fixtures in front of it', async () => {
  await withDemo(async (get) => {
    const response = await get('/');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('<script src="fixtures.js"></script>'), 'the fake chrome is injected');
    assert.match(html, /<script[^>]*src="panel\.js"/, 'and the real panel still loads');
    assert.ok(html.indexOf('fixtures.js') < html.indexOf('panel.js'), 'fixtures first, so chrome exists before the panel runs');
  });
});

test('the demo serves everything the panel imports', async () => {
  await withDemo(async (get) => {
    for (const [file, type] of [['/panel.js', 'text/javascript'], ['/logic.js', 'text/javascript'], ['/panel.css', 'text/css'], ['/fixtures.js', 'text/javascript']]) {
      const response = await get(file);
      assert.equal(response.status, 200, `${file} should be served`);
      assert.match(response.headers.get('content-type'), new RegExp(type));
    }
  });
});

test('the demo will not serve files outside the repo', async () => {
  await withDemo(async (get) => {
    assert.equal((await get('/../../../etc/passwd')).status, 404);
  });
});
