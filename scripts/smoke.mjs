// Smoke test: drive host/bridge.mjs over real native-messaging framing against the
// live Herdr socket, without a browser.
//
//   node scripts/smoke.mjs                 hello, agent.list, subscribe for a moment
//   node scripts/smoke.mjs --agent claude  additionally: workspace in a temp dir → start
//                                          agent → prompt "reply READY" → watch status → close

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = spawn(process.execPath, [path.join(root, 'host', 'bridge.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

let inbound = Buffer.alloc(0);
let seq = 0;
const pending = new Map();

host.stdout.on('data', (chunk) => {
  inbound = Buffer.concat([inbound, chunk]);
  for (;;) {
    if (inbound.length < 4) break;
    const length = inbound.readUInt32LE(0);
    if (inbound.length < 4 + length) break;
    const message = JSON.parse(inbound.subarray(4, 4 + length).toString('utf8'));
    inbound = inbound.subarray(4 + length);
    if (message.subscription) { console.log(`  event ${message.event} ${JSON.stringify(message.data || message.error).slice(0, 140)}`); continue; }
    const p = pending.get(message.id);
    if (!p) continue;
    if (message.progress !== undefined) { console.log(`  … ${message.progress}`); continue; }
    pending.delete(message.id);
    if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `s${++seq}`;
    pending.set(id, { resolve, reject });
    const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    host.stdin.write(Buffer.concat([head, body]));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hello = await send('dia.hello');
console.log('hello', hello.socket, 'pid', hello.pid);

const list = await send('agent.list');
console.log(`agents: ${list.agents.length}`);
for (const a of list.agents) console.log(`  ${a.agent_status.padEnd(8)} ${(a.name || a.display_agent || a.agent || '').padEnd(24)} ${a.cwd || ''}`);

await send('dia.subscribe', {
  subscriptions: [
    { type: 'workspace.created' }, { type: 'workspace.closed' }, { type: 'pane.agent_detected' },
    ...list.agents.map((a) => ({ type: 'pane.agent_status_changed', pane_id: a.pane_id })),
  ],
});
console.log('subscribed');

if (process.argv.includes('--queue')) {
  const ghFlag = process.argv.indexOf('--gh-config');
  const ghConfigDir = ghFlag >= 0 ? process.argv[ghFlag + 1] : undefined;
  const q = await send('dia.queue', { ghConfigDir });
  const line = (pr) => `  ${pr.owner}/${pr.repo}#${pr.number}  ${pr.title.slice(0, 56)}${pr.reason ? `  [${pr.reason}]` : ''}${pr.result ? `  reviewed:${pr.result.findings?.length ?? 0}` : ''}${pr.agent ? `  agent:${pr.agent.name}/${pr.agent.status}` : ''}`;
  console.log(`queue (${q.root}): ${q.brief.length} in your brief · ${q.team.length} via team · ${q.other.length} other`);
  console.log('in your brief:'); for (const pr of q.brief.slice(0, 12)) console.log(line(pr));
  console.log('via team (first 8):'); for (const pr of q.team.slice(0, 8)) console.log(line(pr));
  console.log('other (first 6):'); for (const o of q.other.slice(0, 6)) console.log(`  ${o.repo || ''}  [${o.reason}] ${String(o.title || o.type).slice(0, 60)}`);
}

// --review owner/repo#N [--gh-config DIR] [--claude-config DIR] [--keep]
// Exercise dia.launch in review mode (plan mode: the agent only reads, nothing is posted),
// wait for the review, print what dia.review_text returns, close the workspace unless --keep.
const reviewFlag = process.argv.indexOf('--review');
if (reviewFlag >= 0) {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(process.argv[reviewFlag + 1] || '');
  if (!m) throw new Error('--review needs owner/repo#N');
  const ghFlag = process.argv.indexOf('--gh-config');
  const ccFlag = process.argv.indexOf('--claude-config');
  const rootFlag = process.argv.indexOf('--root');
  const params = {
    owner: m[1], repo: m[2], number: Number(m[3]), mode: 'review', kind: 'claude', focus: false,
    ghConfigDir: ghFlag >= 0 ? process.argv[ghFlag + 1] : undefined,
    claudeConfigDir: ccFlag >= 0 ? process.argv[ccFlag + 1] : undefined,
    reposRoot: rootFlag >= 0 ? process.argv[rootFlag + 1] : undefined,
  };
  console.log(`review launch: ${params.owner}/${params.repo}#${params.number} (plan mode${params.reposRoot ? `, root ${params.reposRoot}` : ''})`);
  const launched = await new Promise((resolve, reject) => {
    const id = `s${++seq}`;
    pending.set(id, { resolve, reject });
    const body = Buffer.from(JSON.stringify({ id, method: 'dia.launch', params }), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    host.stdin.write(Buffer.concat([head, body]));
  });
  console.log(`  launched ${launched.name} in pane ${launched.pane_id} (${launched.cwd})`);
  // Herdr reports `done` when Claude Code finishes a turn — that is the completion signal.
  // `idle` also shows up mid-turn (waiting on a fetch, between tool calls), so only accept
  // it after it has held for a long stretch. `blocked` means it needs a human.
  const seen = [];
  let idlePolls = 0;
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    await sleep(3000);
    const now = await send('agent.list');
    const a = now.agents.find((x) => x.name === launched.name);
    if (!a) { console.log('  agent vanished'); break; }
    if (seen[seen.length - 1] !== a.agent_status) { seen.push(a.agent_status); console.log(`  status ${a.agent_status}`); }
    idlePolls = a.agent_status === 'idle' ? idlePolls + 1 : 0;
    if (a.agent_status === 'done' && seen.includes('working')) break;
    if (a.agent_status === 'blocked' && seen.includes('working')) { console.log('  agent is blocked (needs input) — reading what it has so far'); break; }
    if (idlePolls >= 20 && seen.includes('working')) { console.log('  idle for 60 s — treating as finished'); break; }
  }
  const review = await send('dia.review_text', { name: launched.name });
  console.log(`  review text: ${review.text.length} chars${review.truncated ? ' (truncated)' : ''}`);
  console.log('  ---'); console.log(review.text.split('\n').slice(0, 30).map((l) => `  ${l}`).join('\n')); console.log('  ---');
  console.log('  result:', review.result ? `${review.result.recommendation || '?'} · ${review.result.findings?.length ?? 0} findings · ${review.result.summary || ''}` : '(no HERDR_DIA_RESULT line parsed)');
  // --then "<instruction>": act like the human answering from the panel (dia.proceed).
  const thenFlag = process.argv.indexOf('--then');
  if (thenFlag >= 0) {
    const text = process.argv[thenFlag + 1];
    console.log(`  proceed: ${JSON.stringify(text)}`);
    const proceeded = await new Promise((resolve, reject) => {
      const id = `s${++seq}`;
      pending.set(id, { resolve, reject });
      const body = Buffer.from(JSON.stringify({ id, method: 'dia.proceed', params: { name: launched.name, text } }), 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length, 0);
      host.stdin.write(Buffer.concat([head, body]));
    });
    console.log(`  proceed result: approved=${proceeded.approved}`);
    let last = null;
    const until2 = Date.now() + 5 * 60 * 1000;
    while (Date.now() < until2) {
      await sleep(3000);
      const a = (await send('agent.list')).agents.find((x) => x.name === launched.name);
      if (!a) break;
      if (a.agent_status !== last) { last = a.agent_status; console.log(`  status ${a.agent_status}`); }
      if (['done', 'blocked'].includes(a.agent_status)) break;
    }
    const after = await send('dia.review_text', { name: launched.name });
    console.log('  --- after ---'); console.log(after.text.split('\n').slice(-14).map((l) => `  ${l}`).join('\n')); console.log('  ---');
  }
  if (process.argv.includes('--keep')) console.log(`  keeping workspace ${launched.workspace_id}`);
  else { await send('workspace.close', { workspace_id: launched.workspace_id }); console.log(`  closed workspace ${launched.workspace_id}`); }
}

const flag = process.argv.indexOf('--agent');
if (flag >= 0) {
  const kind = process.argv[flag + 1] || 'claude';
  // --root <dir>: create the throwaway workspace under a tree whose .envrc sets the
  // identities (CLAUDE_CONFIG_DIR, GH_CONFIG_DIR) the agent should run with.
  const rootFlag = process.argv.indexOf('--root');
  const rootDir = rootFlag >= 0 ? process.argv[rootFlag + 1].replace(/^~/, os.homedir()) : os.tmpdir();
  fs.mkdirSync(rootDir, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(rootDir, 'herdr-dia-smoke-'));
  // --claude-config <dir>: the Claude Code config dir (login) the agent should run with.
  const ccFlag = process.argv.indexOf('--claude-config');
  // Same env the host uses: neutralize direnv's inherited state so our values survive.
  const env = { DIRENV_DIFF: '', DIRENV_DIR: '', DIRENV_FILE: '', DIRENV_WATCHES: '' };
  if (ccFlag >= 0) env.CLAUDE_CONFIG_DIR = process.argv[ccFlag + 1].replace(/^~/, os.homedir());
  console.log(`launch test: ${kind} in ${cwd}${env.CLAUDE_CONFIG_DIR ? ` (CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR})` : ''}`);
  const ws = await send('workspace.create', { cwd, label: 'herdr-dia smoke', env, focus: false });
  const name = `smoke-${Date.now().toString(36)}`;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await send('agent.start', { name, kind, pane_id: ws.root_pane.pane_id, timeout_ms: 120000 });
        break;
      } catch (error) {
        if (!/agent_pane_busy/.test(error.message) || attempt > 25) throw error;
        if (attempt === 1) console.log('  pane shell not up yet; retrying agent.start');
        await sleep(750);
      }
    }
    console.log(`started ${name} in pane ${ws.root_pane.pane_id}; waiting for it to be ready`);
    const ready = Date.now() + 180000;
    let readyAt = null;
    let answeredTrust = false;
    while (Date.now() < ready) {
      const now = await send('agent.list');
      const a = now.agents.find((x) => x.name === name);
      if (a && a.agent === kind && a.agent_status === 'idle') { readyAt = Date.now(); break; }
      if (a && a.agent_status === 'blocked' && !answeredTrust) {
        const read = await send('agent.read', { target: name, source: 'visible', lines: 40 });
        if (/trust this folder/i.test(read.read?.text || '')) {
          answeredTrust = true;
          console.log('  folder-trust question: answering Down, Enter');
          await send('agent.send_keys', { target: name, keys: ['down', 'enter'] });
        }
      }
      await sleep(1000);
    }
    if (!readyAt) throw new Error('agent never became ready');
    console.log('  ready');
    await send('agent.prompt', { target: name, text: 'This is a connectivity test from herdr-dia.\nReply with the single word READY and do nothing else.', wait: null });
    console.log('prompted; watching status for up to 45 s');
    const seen = [];
    const until = Date.now() + 45000;
    const settled = Date.now() + 12000;
    while (Date.now() < until) {
      await sleep(2000);
      const now = await send('agent.list');
      const a = now.agents.find((x) => x.name === name);
      if (!a) { console.log('  agent vanished'); break; }
      if (seen[seen.length - 1] !== a.agent_status) { seen.push(a.agent_status); console.log(`  status ${a.agent_status}`); }
      if (a.agent_status === 'done' || (seen.includes('working') && a.agent_status === 'idle')) break;
      if (a.agent_status === 'idle' && Date.now() > settled) break;
    }
    const read = await send('agent.read', { target: name, source: 'recent_unwrapped', lines: 160 });
    const lines = (read.read?.text || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[─│┌┐└┘]+$/.test(l));
    console.log('  recent lines:', JSON.stringify(lines.filter((l) => !/single word READY/.test(l)).slice(-5)));
    // The prompt itself contains "READY"; count only a line that is (or starts with) the reply.
    const answered = lines.some((l) => !/single word READY/.test(l) && /(^|[⏺●]\s*)READY\b/.test(l));
    const loginProblem = lines.some((l) => /login expired|not logged in|run \/login/i.test(l));
    console.log(answered ? '  agent answered READY' : loginProblem ? '  agent is NOT logged in (Claude Code wants /login) — check CLAUDE_CONFIG_DIR for this directory' : '  (no READY reply seen in the visible pane)');
  } finally {
    await send('workspace.close', { workspace_id: ws.workspace.workspace_id }).catch((e) => console.log('  close failed', e.message));
    console.log('closed workspace', ws.workspace.workspace_id);
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  }
} else {
  await sleep(2500);
}

host.stdin.end();
console.log('ok');
