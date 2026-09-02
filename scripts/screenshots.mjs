#!/usr/bin/env node
// Retake docs/screenshots from the fixture demo, so the images in the README are always the
// real panel rendering invented data — and anyone can reproduce them.
//
//   node scripts/screenshots.mjs
//
// It serves the demo (scripts/demo.mjs) and asks headless Chrome for one capture per view, at
// the size a browser side panel actually is. Needs Google Chrome (or Chromium) installed.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
const port = Number(process.env.PORT || 8749);
const width = 440;   // the panel lays out at this width — a browser side panel, roughly
// Retina without --force-device-scale-factor: that flag inflates the layout viewport (and
// Chrome clamps how narrow a headless window may be), so the panel would render far wider
// than a side panel. A double-size window plus page zoom lays out at `width` and paints at 2x.
const scale = 2;

const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => fs.existsSync(p));

// One height per view: each has a different amount of story to fit.
const SHOTS = [
  { file: 'review-ready.png', view: 'review', height: 900, caption: 'a finished review, read in the panel' },
  { file: 'queue-team.png', view: 'team', height: 1240, caption: 'the review queue, grouped by repository' },
  { file: 'mine-merge.png', view: 'mine', height: 1240, caption: 'your own PRs, merge gated on approval' },
  { file: 'settings.png', view: 'settings', height: 900, caption: 'settings: identities, agent, filters' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chrome writes the file and then does not always exit, so wait for the PNG to stop growing
// and kill it rather than waiting on the process.
async function capture(url, file, height) {
  fs.rmSync(file, { force: true });
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=6000',
    `--user-data-dir=${fs.mkdtempSync(path.join(os_tmp(), 'herdr-dia-shots-'))}`,
    `--window-size=${width * scale},${height * scale}`, `--screenshot=${file}`, url,
  ], { stdio: 'ignore' });
  try {
    let last = -1;
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
      if (size > 0 && size === last) return size;
      last = size;
    }
    throw new Error(`no screenshot after 40s: ${url}`);
  } finally {
    child.kill('SIGKILL');
  }
}

function os_tmp() {
  return process.env.TMPDIR || '/tmp';
}

if (!CHROME) {
  console.error('No Chrome found. Install Google Chrome, or set CHROME=/path/to/chrome.');
  process.exit(1);
}

const server = spawn(process.execPath, [path.join(root, 'scripts', 'demo.mjs'), String(port)], { stdio: 'ignore' });
try {
  for (let i = 0; ; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); break; } catch {
      if (i > 100) throw new Error('the demo server never came up');
      await sleep(100);
    }
  }
  fs.mkdirSync(out, { recursive: true });
  for (const shot of SHOTS) {
    const file = path.join(out, shot.file);
    const size = await capture(`http://127.0.0.1:${port}/?view=${shot.view}&zoom=${scale}`, file, shot.height);
    console.log(`${shot.file.padEnd(18)} ${width}×${shot.height} @${scale}x  ${(size / 1024).toFixed(0)} KB  — ${shot.caption}`);
  }
} finally {
  server.kill();
}
