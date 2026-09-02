#!/usr/bin/env node
// Retake docs/screenshots from the fixture demo, so the images in the README are always the
// real panel rendering invented data — and anyone can reproduce them.
//
//   node scripts/screenshots.mjs
//
// One image per card: the README walks through the panel a piece at a time, so each shot
// isolates one card (?only=) in whatever state it should be showing (?view=), and is framed to
// exactly that card's height. Needs Google Chrome (or Chromium) installed.

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

// The two the README shows, side by side, so they want matching heights. The harness can
// isolate any card (?only=this-tab|active|queue|settings) if you want others.
// Four features, one frame each. The review card sets the height and the rest match it, so the
// 2x2 in the README lines up however the fixtures change.
const SHOTS = [
  { file: 'active-review.png', only: 'active', view: 'review', max: 820, caption: 'a finished review, and the reply box' },
  { file: 'peek-review.png', only: 'active', view: 'peek', matchHeight: 'active-review.png', caption: 'peeking at a review still being written' },
  { file: 'queue-mine.png', only: 'queue', view: 'mine', matchHeight: 'active-review.png', caption: 'your own PRs, merge gated on approval' },
  { file: 'queue-favorites.png', only: 'queue', view: 'favorites', matchHeight: 'active-review.png', caption: 'the authors you follow, grouped' },
];

const tmp = () => process.env.TMPDIR || '/tmp';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME_ARGS = [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--virtual-time-budget=6000',
];
const profile = () => `--user-data-dir=${fs.mkdtempSync(path.join(tmp(), 'herdr-dia-shots-'))}`;

function shotUrl(shot) {
  const q = new URLSearchParams({ zoom: String(scale) });
  if (shot.only) q.set('only', shot.only);
  if (shot.view) q.set('view', shot.view);
  return `http://127.0.0.1:${port}/?${q}`;
}

// The harness publishes the height its card settled at; ask for that before capturing, so each
// image is framed to its own card instead of a fixed window. Chrome does not reliably exit after
// --dump-dom either, so read its output until the answer shows up, then kill it.
async function measure(shot) {
  const child = spawn(CHROME, [
    ...CHROME_ARGS, profile(), `--window-size=${width * scale},${1600 * scale}`, '--dump-dom', shotUrl(shot),
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  let dom = '';
  child.stdout.on('data', (chunk) => { dom += chunk; });
  try {
    for (let i = 0; i < 400; i++) {
      await sleep(100);
      const found = /<meta name="capture-height" content="(\d+)">/.exec(dom);
      if (found) return Number(found[1]);
      if (child.exitCode !== null && i > 20) break;
    }
    throw new Error(`${shot.file}: the harness never published a height`);
  } finally {
    child.kill('SIGKILL');
  }
}

// Chrome writes the file and then does not always exit, so wait for the PNG to stop growing
// and kill it rather than waiting on the process.
async function capture(url, file, height) {
  fs.rmSync(file, { force: true });
  const child = spawn(CHROME, [
    ...CHROME_ARGS, profile(),
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
  const taken = new Map(); // file -> height, so matchHeight can look one up
  for (const shot of SHOTS) {
    const file = path.join(out, shot.file);
    const matched = shot.matchHeight ? taken.get(shot.matchHeight) : null;
    const height = matched || Math.min(await measure(shot), shot.max || Infinity);
    taken.set(shot.file, height);
    const size = await capture(shotUrl(shot), file, height);
    console.log(`${shot.file.padEnd(18)} ${width}×${height} @${scale}x  ${(size / 1024).toFixed(0)} KB  — ${shot.caption}`);
  }
} finally {
  server.kill();
}
