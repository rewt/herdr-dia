// herdr-dia native messaging host.
//
// A transparent pipe between the Dia extension and Herdr's local socket, plus three
// host-side routes:
//   dia.queue   the pull requests waiting on your review (via `gh`), merged with any
//               review results agents have already written and any agent working on them
//   dia.launch  turn "this PR + this instruction" into a running agent, in review mode
//               (read, post a review comment, write a findings file) or implement mode
//               (check out the branch, make the change, push)
//   dia.subscribe / dia.hello   event stream and a handshake
//
// No allowlist, no authorization: anything else the extension sends is forwarded to
// Herdr as-is, and whatever Herdr answers comes back as-is.
//
// Wire facts (Herdr 0.8.2, protocol 20): newline-delimited JSON over a unix socket;
// one request per connection (the server closes after replying); events.subscribe is
// the only long-lived stream.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  expandHome, resolveRepoDir, resultPath, agentSlug, agentBase, agentName, AGENT_NAME_RE,
  readResult, extractResult, planFileFromScreen, PLAN_DIALOG, PERMISSION_PROMPT,
  planReviewBrief, reviewBrief, implementBrief, addGitWorktree,
} from './lib.mjs';

const HOME = os.homedir();
const SOCKET = process.env.HERDR_SOCKET_PATH || path.join(HOME, '.config', 'herdr', 'herdr.sock');
const LOG = path.join(os.tmpdir(), 'herdr-dia-host.log');
const DEFAULT_ROOT = '~/herdr-dia';

// Browsers launch native hosts with a bare PATH; put the usual tool dirs back so `gh`
// (and any identity wrapper in front of it) resolves.
process.env.PATH = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || '/usr/bin:/bin'].join(':');

function log(...parts) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`); } catch {}
}

// ---------------------------------------------------------------- native messaging framing
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > 1_000_000) {
    return send({ id: message.id, error: { code: 'too_large', message: 'response exceeds the 1 MB native messaging limit' } });
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let inbound = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbound = Buffer.concat([inbound, chunk]);
  for (;;) {
    if (inbound.length < 4) break;
    const length = inbound.readUInt32LE(0);
    if (inbound.length < 4 + length) break;
    const text = inbound.subarray(4, 4 + length).toString('utf8');
    inbound = inbound.subarray(4 + length);
    let message;
    try { message = JSON.parse(text); } catch (error) { send({ error: { code: 'bad_json', message: error.message } }); continue; }
    handle(message).catch((error) => {
      log('error', message.method, error.message);
      send({ id: message.id, error: error.herdr || { code: 'host_error', message: error.message } });
    });
  }
});
// The panel closing ends stdin. Finish any launch still in flight before exiting, so a
// review dispatched a moment before the panel closed still gets its brief.
let inFlight = 0;
process.stdin.on('end', () => {
  if (subscription) subscription.close();
  const deadline = Date.now() + 5 * 60 * 1000;
  const tick = () => { if (inFlight === 0 || Date.now() > deadline) process.exit(0); else setTimeout(tick, 500); };
  tick();
});

// ---------------------------------------------------------------- herdr socket
function call(method, params = {}, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `h-${Math.random().toString(36).slice(2, 10)}`;
    const socket = net.connect(SOCKET);
    let carry = '';
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); fn(value); };
    const timer = setTimeout(() => finish(reject, new Error(`herdr ${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (data) => {
      carry += data.toString('utf8');
      const newline = carry.indexOf('\n');
      if (newline < 0) return;
      let reply;
      try { reply = JSON.parse(carry.slice(0, newline)); } catch (error) { return finish(reject, error); }
      if (reply.error) { const error = new Error(reply.error.message || 'herdr error'); error.herdr = reply.error; return finish(reject, error); }
      finish(resolve, reply.result);
    });
    socket.on('error', (error) => finish(reject, new Error(`herdr socket ${SOCKET}: ${error.message}`)));
    socket.on('close', () => finish(reject, new Error(`herdr closed the connection before answering ${method}`)));
  });
}

let subscription = null;

function subscribe(subscriptions, onLine) {
  let active = true;
  let socket = null;
  const open = () => {
    if (!active) return;
    socket = net.connect(SOCKET);
    let carry = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions } })}\n`));
    socket.on('data', (data) => {
      carry += data.toString('utf8');
      let newline;
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (!line.trim()) continue;
        try { onLine(JSON.parse(line)); } catch (error) { log('subscribe parse', error.message); }
      }
    });
    socket.on('error', (error) => log('subscribe socket', error.message));
    socket.on('close', () => { if (active) setTimeout(open, 1000); });
  };
  open();
  return { close() { active = false; if (socket) socket.destroy(); } };
}

// ---------------------------------------------------------------- gh
function gh(args, { cwd, ghConfigDir } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_IDENTITY_QUIET: '1' };
    if (ghConfigDir) env.GH_CONFIG_DIR = expandHome(ghConfigDir);
    // A `gh` identity wrapper on PATH maps the account by directory; run from a neutral dir
    // (unless a cwd is given) so the explicit GH_CONFIG_DIR is what decides the identity.
    execFile('gh', args, { cwd: cwd || os.tmpdir(), env, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`gh ${args.slice(0, 2).join(' ')}: ${String(stderr || error.message).trim()}`));
      resolve(String(stdout));
    });
  });
}

// Right after workspace.create the root pane's shell may not be up yet, and agent.start
// answers agent_pane_busy. Retry that one error for a few seconds.
async function startAgent({ name, kind, paneId, args = [], timeoutMs = 120_000 }) {
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      return await call('agent.start', { name, kind, pane_id: paneId, args, timeout_ms: timeoutMs }, { timeoutMs: timeoutMs + 10_000 });
    } catch (error) {
      if (error.herdr?.code !== 'agent_pane_busy' || Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

// Claude Code's folder-trust dialog preselects "No, exit". Sending Down and Enter in one
// write can reach the dialog as a single chunk that it reads as Escape (= exit), so: send
// Down, confirm the highlight moved to "Yes", then send Enter on its own.
async function answerTrustDialog(name) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 4; attempt++) {
    await call('agent.send_keys', { target: name, keys: ['down'] });
    await sleep(400);
    const read = await call('agent.read', { target: name, source: 'visible', lines: 40 }).catch(() => null);
    const text = read?.read?.text || '';
    if (!/trust this folder/i.test(text)) return; // dialog already gone
    if (/❯\s*Yes, I trust this folder/.test(text)) break;
  }
  await call('agent.send_keys', { target: name, keys: ['enter'] });
  await sleep(600);
}

// ---------------------------------------------------------------- plan-mode dialog driving
async function visibleText(name, lines = 60) {
  const read = await call('agent.read', { target: name, source: 'visible', lines }).catch(() => null);
  return read?.read?.text || '';
}

async function agentStatus(name) {
  const { agents = [] } = await call('agent.list');
  return agents.find((a) => a.name === name) || null;
}

// Move the highlight in a Claude Code select dialog to the option matching `pattern` and
// press Enter. Options are the lines near the highlight marker (❯); one key per write, with
// a re-read between, so keystrokes are never coalesced into an Escape.
async function selectDialogOption(name, pattern) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isOption = (l) => /^\s*(❯\s*)?\d+\.\s+\S/.test(l);
  for (let attempt = 0; attempt < 8; attempt++) {
    const lines = (await visibleText(name, 80)).split('\n');
    // The highlight is "❯ N. …". Claude Code's input box and the shell echo also start
    // with ❯, so anchor on the highlighted *numbered* option — the last one on screen.
    let current = -1;
    lines.forEach((l, i) => { if (/^\s*❯\s*\d+\.\s+\S/.test(l)) current = i; });
    if (current < 0) throw new Error('no highlighted option on screen');
    // Options are the numbered lines around the highlight ("❯ 1. Yes, and use auto mode").
    const target = lines.findIndex((l, i) => Math.abs(i - current) <= 6 && isOption(l) && pattern.test(l.replace(/^\s*(❯\s*)?\d+\.\s+/, '')));
    if (target < 0) throw new Error(`no dialog option matching ${pattern}`);
    if (target === current) {
      await call('agent.send_keys', { target: name, keys: ['enter'] });
      await sleep(600);
      return;
    }
    await call('agent.send_keys', { target: name, keys: [target > current ? 'down' : 'up'] });
    await sleep(350);
  }
  throw new Error('could not move the dialog highlight');
}

// If the agent is parked on the exit-plan-mode dialog, answer "No, keep planning" so it
// returns to its prompt (still in plan mode) and its scrollback becomes readable.
async function dismissPlanDialog(name) {
  const agent = await agentStatus(name);
  if (!agent || agent.agent_status !== 'blocked') return false;
  if (!PLAN_DIALOG.test(await visibleText(name))) return false;
  await selectDialogOption(name, /tell claude what to change|keep planning|^No\b/i);
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const now = await agentStatus(name);
    if (now && now.agent_status !== 'blocked') return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return true;
}

// dia.proceed: the human has read the review and told the agent what to do. Dismiss the
// plan dialog if it is up, send the instruction, and when Claude asks to leave plan mode
// for it, approve on the human's behalf — their instruction was the approval.
async function proceed(id, { name, text }) {
  if (!name || !text?.trim()) throw new Error('proceed needs the agent name and an instruction');
  const progress = (t) => send({ id, progress: t });
  if (await dismissPlanDialog(name)) progress('dismissed the plan dialog');
  await call('agent.prompt', { target: name, text: `${text.trim()}\nYou have my approval to leave plan mode and act on this; do not ask me again.`, wait: null });
  progress('instruction sent; answering the prompts it raises');
  // The human's instruction is the approval. From here on, answer Claude's own ceremony:
  // the exit-plan dialog (pick "Yes, and use auto mode") and the ordinary tool permission
  // prompts ("Do you want to create/run …?" — pick the "switch to accept edits for this
  // session" option when offered, else "Yes"). Anything unrecognized is left for the
  // human in Herdr.
  const until = Date.now() + 6 * 60 * 1000;
  let approved = false;
  let approvals = 0;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const agent = await agentStatus(name);
    if (!agent) break;
    if (agent.agent_status === 'blocked') {
      const screen = await visibleText(name, 80);
      if (PLAN_DIALOG.test(screen)) {
        await selectDialogOption(name, /^Yes\b.*\bauto/i).catch(() => selectDialogOption(name, /^Yes\b/i));
        approved = true;
        progress('approved leaving plan mode');
        continue;
      }
      const question = (screen.split('\n').find((l) => PERMISSION_PROMPT.test(l)) || '').trim();
      if (question) {
        await selectDialogOption(name, /switch to accept edits|don'?t ask again/i).catch(() => selectDialogOption(name, /^Yes\b/i));
        approvals++;
        progress(`approved: ${question.slice(0, 80)}`);
        continue;
      }
      progress(`${name} is waiting for input in Herdr`);
      break;
    }
    if (agent.agent_status === 'done') break;
  }
  send({ id, result: { type: 'proceeding', name, approved, approvals } });
}

// agent.start returns before Herdr has bound the name; prompting then fails with
// agent_not_ready, and prompting a blocked agent fails with agent_blocked. Poll until
// the named agent is detected and sitting idle. A brand-new Claude Code checkout stops
// at its folder-trust question (default answer "No, exit"), which Herdr reports as
// blocked — answer it with Down, Enter and keep waiting. Any other blocked state is the
// user's to answer in Herdr; the brief follows once the agent is idle.
async function waitForAgent(name, kind, { timeoutMs = 180_000, onProgress = () => {} } = {}) {
  const until = Date.now() + timeoutMs;
  let answeredTrust = false;
  let reportedBlocked = false;
  let idleStreak = 0;
  let seenOnce = false;
  while (Date.now() < until) {
    const { agents = [] } = await call('agent.list');
    const agent = agents.find((a) => a.name === name);
    if (!agent && seenOnce) throw new Error(`agent ${name} exited before it was ready (check its pane in Herdr)`);
    if (agent && agent.agent === kind) {
      seenOnce = true;
      // Status detection flickers between polls; require idle to hold before trusting it.
      idleStreak = agent.agent_status === 'idle' ? idleStreak + 1 : 0;
      if (idleStreak >= 2) return agent;
      if (agent.agent_status === 'blocked') {
        const read = await call('agent.read', { target: name, source: 'visible', lines: 40 }).catch(() => null);
        const text = read?.read?.text || '';
        if (!answeredTrust && /trust this folder/i.test(text)) {
          answeredTrust = true;
          onProgress('answering the folder-trust question');
          await answerTrustDialog(name);
        } else if (!reportedBlocked) {
          reportedBlocked = true;
          onProgress(`${name} is waiting for input in Herdr — answer it and the brief will follow`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`agent ${name} did not become ready within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------- routes
async function handle(message) {
  const { id, method, params = {} } = message;
  if (!method) throw new Error('message has no method');

  if (method === 'dia.hello') {
    return send({ id, result: { type: 'hello', socket: SOCKET, pid: process.pid, home: HOME, defaultRoot: DEFAULT_ROOT } });
  }

  if (method === 'dia.subscribe') {
    if (subscription) subscription.close();
    subscription = subscribe(params.subscriptions || [], (line) => {
      if (line.event) send({ subscription: id, event: line.event, data: line.data });
      else if (line.error) send({ subscription: id, error: line.error });
    });
    return send({ id, result: { type: 'subscribed', count: (params.subscriptions || []).length } });
  }

  if (method === 'dia.config') return send({ id, result: await config() });
  if (method === 'dia.resolve_user') return send({ id, result: await resolveUser(params) });
  if (method === 'dia.merge_pr') return send({ id, result: await mergePr(params) });
  if (method === 'dia.sessions') return send({ id, result: await sessions() });
  if (method === 'dia.dismiss_session') return send({ id, result: dismissSession(params) });
  if (method === 'dia.end_session') return send({ id, result: await endSession(params) });
  if (method === 'dia.worktrees') return send({ id, result: await listWorktrees(params) });
  if (method === 'dia.remove_worktree') return send({ id, result: await removeWorktree(params) });
  if (method === 'dia.queue') return send({ id, result: await queue(params) });
  if (method === 'dia.launch') { inFlight++; try { return await launch(id, params); } finally { inFlight--; } }
  if (method === 'dia.review_text') return send({ id, result: await reviewText(params) });
  if (method === 'dia.proceed') { inFlight++; try { return await proceed(id, params); } finally { inFlight--; } }

  const result = await call(method, params);
  send({ id, result });
}

// dia.config: everything the settings menu can offer deterministically —
//   identities   the gh config dirs on this machine, each with the account it authenticates
//   agents       the coding agents Herdr knows about (this is the "LLM selector")
//   claudeConfigs the ~/.claude* dirs (Claude Code logins)
async function config() {
  const identities = [];
  const configHome = path.join(HOME, '.config');
  try {
    for (const entry of fs.readdirSync(configHome, { withFileTypes: true })) {
      if (!entry.isDirectory() || !(entry.name === 'gh' || entry.name.startsWith('gh-'))) continue;
      const dir = path.join(configHome, entry.name);
      let account = null;
      try {
        const hosts = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8');
        account = (/^\s*user:\s*(\S+)/m.exec(hosts) || [])[1] || null;
      } catch {}
      identities.push({ dir, name: entry.name, account, isDefault: entry.name === 'gh' });
    }
  } catch {}
  identities.sort((a, b) => (b.isDefault - a.isDefault) || String(a.account).localeCompare(String(b.account)));

  let agents = [];
  try {
    const manifests = (await call('server.agent_manifests')).manifests || [];
    agents = manifests.map((m) => ({ kind: m.agent, version: m.active_version || null })).filter((a) => a.kind);
  } catch (error) { log('agent_manifests', error.message); }

  const claudeConfigs = [];
  try {
    for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === '.claude' || entry.name.startsWith('.claude-'))) {
        const dir = path.join(HOME, entry.name);
        claudeConfigs.push({ dir, name: entry.name, loggedIn: fs.existsSync(path.join(dir, '.credentials.json')), isDefault: entry.name === '.claude' });
      }
    }
  } catch {}

  return { type: 'config', identities, agents, claudeConfigs, defaultRoot: DEFAULT_ROOT };
}

// Resolve a typed GitHub username against the API so a favorite is a real account (and stored
// with its canonical casing), not a typo.
async function resolveUser({ login, ghConfigDir }) {
  // Standard logins are alphanumeric + hyphen; enterprise-managed usernames add an
  // underscore shortcode (e.g. alice_acme), so allow underscores and dots too.
  const clean = String(login || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/.test(clean)) {
    const e = new Error('enter a GitHub username'); e.herdr = { code: 'invalid', message: e.message }; throw e;
  }
  try {
    const raw = await gh(['api', `users/${clean}`, '--jq', '{login: .login, name: .name, type: .type}'], { ghConfigDir });
    const u = JSON.parse(raw);
    return { type: 'user', login: u.login, name: u.name || null, kind: u.type || null };
  } catch {
    const e = new Error(`no GitHub user "${clean}"`); e.herdr = { code: 'not_found', message: e.message }; throw e;
  }
}

// Merge one of your own PRs. Picks a merge method the repo actually allows (squash → merge →
// rebase) unless one is given. This is the real thing — it merges to the base branch.
async function mergePr({ owner, repo, number, ghConfigDir, method }) {
  if (!owner || !repo || !number) throw new Error('merge_pr needs owner, repo and number');
  let m = method;
  if (!m) {
    try {
      const raw = await gh(['api', `repos/${owner}/${repo}`, '--jq', '{squash: .allow_squash_merge, merge: .allow_merge_commit, rebase: .allow_rebase_merge}'], { ghConfigDir });
      const a = JSON.parse(raw);
      m = a.squash ? 'squash' : a.merge ? 'merge' : a.rebase ? 'rebase' : 'merge';
    } catch { m = 'merge'; }
  }
  try {
    const out = await gh(['pr', 'merge', String(number), '--repo', `${owner}/${repo}`, `--${m}`], { ghConfigDir });
    return { type: 'merged', owner, repo, number, method: m, output: out.trim() };
  } catch (error) {
    const e = new Error(String(error.message).replace(/^gh pr merge:\s*/, '').trim());
    e.herdr = { code: 'merge_failed', message: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- sessions
// Every dispatch is remembered so the panel can show each as its own interactive session,
// with the PR context (owner/repo/number/url/title) the review controls need — independent
// of whether that PR is currently in the queue or the active tab.
const sessionsRegistry = path.join(HOME, '.herdr-dia', 'sessions.json');
function readSessions() {
  try { return JSON.parse(fs.readFileSync(sessionsRegistry, 'utf8')); } catch { return {}; }
}
function writeSessions(reg) {
  fs.mkdirSync(path.dirname(sessionsRegistry), { recursive: true });
  fs.writeFileSync(sessionsRegistry, JSON.stringify(reg, null, 2));
}
function recordSession(entry) {
  const reg = readSessions();
  reg[entry.agentName] = { ...entry, createdAt: new Date().toISOString() };
  writeSessions(reg);
}

async function sessions() {
  const reg = readSessions();
  const { agents = [] } = await call('agent.list').catch(() => ({ agents: [] }));
  const live = new Map(agents.map((a) => [a.name, a]));
  let changed = false;

  // Self-heal: reconstruct a session for any dia agent not already recorded (launched by a
  // previous host, or after the registry was cleared). Full identity comes from the checkout's
  // git remote when there is one; a plan-mode review runs in a bare dir, so the repo falls back
  // to the slug in the agent name and the full owner/repo is filled in later from the review.
  for (const a of agents) {
    const m = AGENT_NAME_RE.exec(a.name || '');
    if (!m || reg[a.name]) continue;
    let owner = null; let repo = m[3]; let url = null;
    try {
      const remote = execFileSync('git', ['-C', a.cwd || '.', 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000 }).trim();
      const rm = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
      if (rm) { owner = rm[1]; repo = rm[2]; url = `https://github.com/${owner}/${repo}/pull/${m[2]}`; }
    } catch {}
    reg[a.name] = { agentName: a.name, owner, repo, number: Number(m[2]), mode: m[1] === 'rv' ? 'review' : 'implement', url, title: null, workspaceId: a.workspace_id, tabId: null, reconstructed: true, createdAt: new Date().toISOString() };
    changed = true;
  }

  const out = [];
  for (const [name, s] of Object.entries(reg)) {
    const a = live.get(name);
    // Forget a finished session whose agent is gone after a day, so the list doesn't grow.
    if (!a && Date.now() - new Date(s.createdAt).getTime() > 24 * 3600 * 1000) { delete reg[name]; changed = true; continue; }
    out.push({ ...s, status: a?.agent_status || 'gone', paneId: a?.pane_id || null, result: s.mode === 'review' && s.owner ? readResult(resultPath(null, s.owner, s.repo, s.number)) : null });
  }
  if (changed) writeSessions(reg);
  out.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  return { type: 'sessions', sessions: out };
}

// A reconstructed session may lack its full owner/repo (a plan-mode review runs in a bare
// dir). The review's HERDR_DIA_RESULT carries "pr":"owner/repo#n" — use it to fill them in so
// Post-as-comment / Apply-the-fixes work.
function backfillSession(name, result) {
  const pr = result?.pr;
  const m = /^([^/]+)\/([^#]+)#\d+$/.exec(pr || '');
  if (!m) return;
  const reg = readSessions();
  const s = reg[name];
  if (!s || (s.owner && !s.reconstructed)) return;
  if (s.owner === m[1] && s.repo === m[2]) return;
  reg[name] = { ...s, owner: m[1], repo: m[2], url: s.url || `https://github.com/${m[1]}/${m[2]}/pull/${s.number}` };
  writeSessions(reg);
}

// Forget a session (stop showing it in Active). Leaves any tab/worktree alone — those are
// managed in Herdr and in the Worktrees settings.
function dismissSession({ agentName }) {
  if (!agentName) throw new Error('dismiss_session needs an agentName');
  const reg = readSessions();
  delete reg[agentName];
  writeSessions(reg);
  return { type: 'session_dismissed', agentName };
}

// Actually close a session out: shut its Herdr tab (which stops the agent in it) and drop it
// from the board. If it was an update, also remove its git worktree when clean — keeping the
// branch, so committed work is never lost; a dirty worktree is left for the Worktrees settings.
async function endSession({ agentName }) {
  if (!agentName) throw new Error('end_session needs an agentName');
  const reg = readSessions();
  const s = reg[agentName];
  const { agents = [] } = await call('agent.list').catch(() => ({ agents: [] }));
  const a = agents.find((x) => x.name === agentName);
  const tabId = s?.tabId || a?.tab_id || null;

  if (tabId) { await call('tab.close', { tab_id: tabId }).catch((error) => log('end tab.close', error.message)); }
  else if (a?.pane_id) { await call('pane.close', { pane_id: a.pane_id }).catch((error) => log('end pane.close', error.message)); }

  const wreg = readRegistry();
  const wtId = tabId && (wreg[tabId] ? tabId : Object.keys(wreg).find((k) => wreg[k].tabId === tabId));
  if (wtId) {
    const wt = wreg[wtId];
    try {
      execFileSync('git', ['-C', wt.sourceCheckout, 'worktree', 'remove', wt.checkoutPath], { stdio: 'pipe' });
      execFileSync('git', ['-C', wt.sourceCheckout, 'worktree', 'prune'], { stdio: 'pipe' });
      delete wreg[wtId];
      writeRegistry(wreg);
    } catch (error) { log('end worktree kept (dirty?)', error.message); }
  }

  if (s) { delete reg[agentName]; writeSessions(reg); }
  return { type: 'session_ended', agentName, closedTab: tabId };
}

// ---------------------------------------------------------------- worktree lifecycle
// Update-mode dispatches create a Herdr worktree off the checkout (branch herdr-dia/pr-<n>).
// We record each one so the panel can list them and tear them down; the record lives in
// home state, never in a checkout.
const worktreeRegistry = path.join(HOME, '.herdr-dia', 'worktrees.json');

function readRegistry() {
  try { return JSON.parse(fs.readFileSync(worktreeRegistry, 'utf8')); } catch { return {}; }
}
function writeRegistry(reg) {
  fs.mkdirSync(path.dirname(worktreeRegistry), { recursive: true });
  fs.writeFileSync(worktreeRegistry, JSON.stringify(reg, null, 2));
}
function recordWorktree(entry) {
  const reg = readRegistry();
  reg[entry.id] = { ...entry, createdAt: new Date().toISOString() };
  writeRegistry(reg);
}

async function listWorktrees() {
  const reg = readRegistry();
  const out = [];
  for (const [id, e] of Object.entries(reg)) {
    // Cleanliness is read from git directly — fast, and no agent needs to be involved.
    let clean = null;
    if (fs.existsSync(e.checkoutPath)) {
      try {
        const status = execFileSync('git', ['-C', e.checkoutPath, 'status', '--porcelain'], { encoding: 'utf8', timeout: 8000 });
        clean = status.trim().length === 0;
      } catch { clean = null; }
    }
    out.push({ ...e, id, clean, exists: fs.existsSync(e.checkoutPath) });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { type: 'worktrees', worktrees: out };
}

// Non-destructive by design: `git worktree remove` without --force refuses a dirty tree, and
// the branch is always retained, so an update that committed is safe to tear down — its
// commits live on in the branch (and on the PR, if pushed). The tab is closed with it.
async function removeWorktree({ id, force = false }) {
  if (!id) throw new Error('remove_worktree needs an id');
  const reg = readRegistry();
  const entry = reg[id];
  if (!entry) return { type: 'worktree_removed', id, branch: null };
  if (fs.existsSync(entry.checkoutPath)) {
    try {
      execFileSync('git', ['-C', entry.sourceCheckout, 'worktree', 'remove', ...(force ? ['--force'] : []), entry.checkoutPath], { stdio: 'pipe' });
    } catch (error) {
      const msg = String(error.stderr || error.message);
      if (/contains modified or untracked|is dirty|use --force/i.test(msg)) {
        const e = new Error('worktree has uncommitted changes; commit or discard them first');
        e.herdr = { code: 'worktree_dirty', message: e.message };
        throw e;
      }
      // Already gone: fall through and forget it.
    }
    try { execFileSync('git', ['-C', entry.sourceCheckout, 'worktree', 'prune'], { stdio: 'pipe' }); } catch {}
  }
  if (entry.tabId) await call('tab.close', { tab_id: entry.tabId }).catch(() => {});
  delete reg[id];
  writeRegistry(reg);
  return { type: 'worktree_removed', id, branch: entry.branch || null };
}

// Your own PRs, enriched with review decision + mergeability via one GraphQL query. Falls back
// to a plain REST search (no review/merge data) if GraphQL errors, so the list is never empty
// just because the enrichment hiccuped. Returns normalized nodes.
async function fetchMine(mineState, ghOptions) {
  const q = `query { search(query: "is:pr is:${mineState} author:@me sort:updated-desc", type: ISSUE, first: 100) { nodes { ... on PullRequest { number title url updatedAt isDraft reviewDecision mergeable author { login } repository { nameWithOwner } } } } }`;
  try {
    const raw = await gh(['api', 'graphql', '-f', `query=${q}`], ghOptions);
    const nodes = JSON.parse(raw)?.data?.search?.nodes || [];
    return nodes.map((n) => ({ number: n.number, title: n.title, url: n.url, updatedAt: n.updatedAt, isDraft: n.isDraft, reviewDecision: n.reviewDecision ?? null, mergeable: n.mergeable ?? null, nameWithOwner: n.repository?.nameWithOwner, login: n.author?.login }));
  } catch (error) {
    log('mine graphql', error.message);
    try {
      const raw = await gh(['search', 'prs', '--author=@me', '--state', mineState, '--limit', '100', '--json', 'number,title,repository,url,updatedAt,author,isDraft'], ghOptions);
      return JSON.parse(raw).map((it) => ({ number: it.number, title: it.title, url: it.url, updatedAt: it.updatedAt, isDraft: it.isDraft, reviewDecision: null, mergeable: null, nameWithOwner: it.repository?.nameWithOwner, login: it.author?.login }));
    } catch (error2) { log('mine rest', error2.message); return []; }
  }
}

// dia.queue: three tiers, mirroring how the daily brief ranks GitHub to-dos.
//   brief  PRs with an unread GitHub notification addressed to me (review requested,
//          mentioned, assigned, my own PR's activity) — newest first, with the reason
//   team   everything else that requests my review (via CODEOWNERS/teams), by repo
//   other  non-PR notifications (deployment approvals, CI) — links only
// Each PR carries any review result already written and any agent working on it.
async function queue(p) {
  const root = expandHome(p.reposRoot || DEFAULT_ROOT);
  fs.mkdirSync(root, { recursive: true });
  const ghOptions = { cwd: root, ghConfigDir: p.ghConfigDir };
  // Default to unapproved only — an approved PR no longer needs your eyes. `review:required`
  // is applied at the search so the fetch itself is smaller.
  const onlyUnapproved = p.onlyUnapproved !== false;
  // Mine: your own PRs. Default to open (still waiting), with a toggle to closed/merged.
  const mineState = p.mineState === 'closed' ? 'closed' : 'open';
  const repoFilter = new Set((p.repos || []).map((r) => r.toLowerCase()));
  const inFilter = (owner, repo) => !repoFilter.size || repoFilter.has(repo.toLowerCase()) || repoFilter.has(`${owner}/${repo}`.toLowerCase());
  const searchArgs = ['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '100', '--json', 'number,title,repository,url,updatedAt,author'];
  if (onlyUnapproved) searchArgs.splice(4, 0, '--review', 'required');
  const [notificationsRaw, requestedRaw, mineRaw, agents] = await Promise.all([
    gh(['api', 'notifications?all=false&per_page=100'], ghOptions).catch((error) => { log('notifications', error.message); return '[]'; }),
    gh(searchArgs, ghOptions),
    fetchMine(mineState, ghOptions),
    call('agent.list').then((r) => r.agents || []).catch(() => []),
  ]);

  const decorate = (pr) => {
    const reviewer = agents.find((a) => a.name?.startsWith(`${agentBase('review', pr.repo, pr.number)}-`));
    const fixer = agents.find((a) => a.name?.startsWith(`${agentBase('implement', pr.repo, pr.number)}-`));
    const active = fixer || reviewer;
    pr.result = readResult(resultPath(root, pr.owner, pr.repo, pr.number));
    pr.agent = active ? { name: active.name, status: active.agent_status, kind: active.agent, pane_id: active.pane_id, mode: fixer ? 'implement' : 'review' } : null;
    return pr;
  };

  const knownRepos = new Set();
  const brief = new Map();
  const other = [];
  for (const n of JSON.parse(notificationsRaw)) {
    const m = /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(n.subject?.url || '');
    if (n.subject?.type === 'PullRequest' && m) {
      knownRepos.add(m[2]);
      if (!inFilter(m[1], m[2])) continue;
      const key = `${m[1]}/${m[2]}#${m[3]}`;
      if (!brief.has(key)) {
        brief.set(key, { owner: m[1], repo: m[2], number: Number(m[3]), title: n.subject.title, url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`, updatedAt: n.updated_at, author: null, reason: n.reason, threadId: n.id });
      }
    } else {
      other.push({ title: n.subject?.title || n.reason, reason: n.reason, type: n.subject?.type || null, repo: n.repository?.full_name || null, url: n.repository?.html_url || null, updatedAt: n.updated_at, threadId: n.id });
    }
  }

  const team = [];
  for (const item of JSON.parse(requestedRaw)) {
    const [owner, repo] = String(item.repository?.nameWithOwner || '').split('/');
    knownRepos.add(repo);
    const key = `${owner}/${repo}#${item.number}`;
    const pr = { owner, repo, number: item.number, title: item.title, url: item.url, updatedAt: item.updatedAt, author: item.author?.login || null };
    if (brief.has(key)) { Object.assign(brief.get(key), { author: pr.author }); continue; }
    if (!inFilter(owner, repo)) continue;
    team.push(pr);
  }

  // Mine: your own PRs across repos, newest first (respects the repo filter). Open state hides
  // drafts. Each carries its review decision (for the approved checkmark) and mergeability
  // (to enable the merge button).
  const mine = [];
  for (const node of mineRaw) {
    if (mineState === 'open' && node.isDraft) continue;
    const [owner, repo] = String(node.nameWithOwner || '').split('/');
    if (!owner) continue;
    knownRepos.add(repo);
    if (!inFilter(owner, repo)) continue;
    mine.push(decorate({
      owner, repo, number: node.number, title: node.title, url: node.url, updatedAt: node.updatedAt,
      author: node.login || null, reviewDecision: node.reviewDecision ?? null, mergeable: node.mergeable ?? null,
    }));
  }
  mine.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  let briefList = [...brief.values()].map(decorate).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  team.forEach(decorate);
  let teamList = team.sort((a, b) => a.repo.localeCompare(b.repo) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  other.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  // Favorites: authors you've marked. Their PRs are pulled out of brief/team into a top tier
  // (the "team" you care about), grouped by author. Every author seen becomes a known chip.
  const knownAuthors = new Set([...briefList, ...teamList].map((pr) => pr.author).filter(Boolean));
  const favSet = new Set((p.favorites || []).map((f) => f.toLowerCase().replace(/^@/, '')));
  const isFav = (pr) => pr.author && favSet.has(pr.author.toLowerCase());
  const favorites = [...briefList.filter(isFav), ...teamList.filter(isFav)]
    .sort((a, b) => String(a.author).localeCompare(String(b.author)) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  briefList = briefList.filter((pr) => !isFav(pr));
  teamList = teamList.filter((pr) => !isFav(pr));

  return {
    type: 'queue', root, favorites, mine, brief: briefList, team: teamList, other,
    prs: [...favorites, ...mine, ...briefList, ...teamList],
    knownRepos: [...knownRepos].sort(), knownAuthors: [...knownAuthors].sort((a, b) => a.localeCompare(b)),
    onlyUnapproved, mineState, repoFilterActive: repoFilter.size > 0,
  };
}

// dia.review_text: the reviewer agent's recent output, plus the HERDR_DIA_RESULT JSON if it
// printed one (plan-mode reviews can't write files, so the result travels in the reply).
// While parked on the exit-plan dialog, Claude Code shows where it wrote the plan
// ("ctrl+g to edit in Nvim · ~/.claude-personal/plans/<slug>.md"). Read the plan file:
// that is the full review, without touching the dialog.
async function reviewText({ name, lines = 600 }) {
  if (!name) throw new Error('review_text needs the agent name');
  const agent = await agentStatus(name);
  if (agent?.agent_status === 'blocked') {
    const screen = await visibleText(name, 80);
    const planFile = planFileFromScreen(screen);
    if (PLAN_DIALOG.test(screen) && planFile && fs.existsSync(planFile)) {
      const plan = fs.readFileSync(planFile, 'utf8');
      const planResult = extractResult(plan);
      backfillSession(name, planResult);
      return { type: 'review_text', name, text: plan.trim(), result: planResult, truncated: false, source: 'plan-file', planFile, awaitingDecision: true };
    }
  }
  // Otherwise: an idle agent's scrollback holds the conversation. Herdr can only scroll
  // an agent's alternate-screen history while it is idle; while it is working (or parked
  // on some other prompt), fall back to what is visible right now.
  let read;
  try {
    read = await call('agent.read', { target: name, source: 'recent_unwrapped', lines });
  } catch (error) {
    if (error.herdr?.code !== 'agent_not_idle') throw error;
    read = await call('agent.read', { target: name, source: 'visible', lines: 80 });
  }
  const text = read.read?.text || '';
  const result = extractResult(text);
  // Trim the TUI chrome: keep from the brief's end (the first "⏺" reply) onward when present.
  backfillSession(name, result);
  const reply = text.indexOf('\n⏺');
  const body = (reply >= 0 ? text.slice(reply + 1) : text).replace(/^[─│]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { type: 'review_text', name, text: body, result, truncated: Boolean(read.read?.truncated), source: 'pane', awaitingDecision: false };
}

// Mark a notification thread read so the to-do clears from the brief once an agent has it.
async function markRead(threadId, p) {
  if (!threadId) return;
  await gh(['api', '-X', 'PATCH', `notifications/threads/${threadId}`], { ghConfigDir: p.ghConfigDir }).catch((error) => log('markRead', error.message));
}

// One workspace for everything the extension launches, labeled `herdr-dia`. Every PR — any
// repo, review or update — is a tab inside it. Discovered by label from the live snapshot so
// it survives host restarts; recreated if the user closed it.
async function ensureDiaWorkspace(root, env) {
  try {
    const snap = await call('session.snapshot');
    const existing = (snap.snapshot?.workspaces || snap.workspaces || []).find((w) => w.label === 'herdr-dia');
    if (existing) return existing.workspace_id;
  } catch (error) { log('snapshot', error.message); }
  fs.mkdirSync(root, { recursive: true });
  const created = await call('workspace.create', { cwd: root, label: 'herdr-dia', env, focus: false });
  return created.workspace.workspace_id;
}

// workspace.create always leaves an empty root tab (a plain shell). Herdr labels those with a
// bare number; our session tabs always carry a "#". Close the empty ones once a real session
// tab exists, so the workspace holds only sessions and closes itself when the last one ends.
async function sweepEmptyTabs(workspaceId, keepTabId) {
  const tabs = (await call('tab.list', { workspace_id: workspaceId }).catch(() => ({ tabs: [] }))).tabs || [];
  if (tabs.length <= 1) return;
  for (const t of tabs) {
    if (t.tab_id !== keepTabId && /^\d+$/.test(String(t.label || ''))) {
      await call('tab.close', { tab_id: t.tab_id }).catch((error) => log('sweep tab', error.message));
    }
  }
}

// dia.launch: PR + instruction -> workspace for the repo -> agent -> brief.
async function launch(id, p) {
  const progress = (text) => send({ id, progress: text });
  const { owner, repo, number, url, title = '', instruction = '', kind = 'claude', focus = true } = p;
  const mode = p.mode === 'review' ? 'review' : 'implement';
  if (!owner || !repo || !number) throw new Error('launch needs owner, repo and number');
  const root = expandHome(p.reposRoot || DEFAULT_ROOT);
  fs.mkdirSync(root, { recursive: true });
  const located = resolveRepoDir(root, owner, repo);
  const resultFile = mode === 'review' ? resultPath(root, owner, repo, number) : null;
  if (resultFile) fs.mkdirSync(path.dirname(resultFile), { recursive: true });

  // Identities travel with the workspace: gh's config dir for the queue/pushes, and
  // Claude Code's config dir (login + settings) for the agent itself.
  // The Herdr server inherits whatever direnv had exported where it was launched; when
  // a new pane starts in a directory without an .envrc, direnv "unloads" and reverts
  // every variable in its recorded diff — including ones set here. Clearing direnv's
  // state makes the pane start clean, so these values survive (and the directory's own
  // .envrc, if any, still loads normally).
  const env = { GH_IDENTITY_QUIET: '1', DIRENV_DIFF: '', DIRENV_DIR: '', DIRENV_FILE: '', DIRENV_WATCHES: '' };
  if (p.ghConfigDir) env.GH_CONFIG_DIR = expandHome(p.ghConfigDir);
  if (p.claudeConfigDir) env.CLAUDE_CONFIG_DIR = expandHome(p.claudeConfigDir);

  // Everything lands as a tab in the single `herdr-dia` workspace, labeled `<repo>#<n>`.
  // Reviews (read-only, plan mode) run a tab in the checkout — many PRs, any repo, side by
  // side without colliding. Updates run a tab in their own git worktree per PR branch, so two
  // updates of the same repo never touch each other's files.
  fs.mkdirSync(located.dir, { recursive: true });
  const workspaceId = await ensureDiaWorkspace(root, env);
  let cwd = located.dir;
  let tabId;
  let paneId;
  if (mode === 'implement' && located.existing) {
    const branch = `herdr-dia/pr-${number}`;
    cwd = path.join(HOME, '.herdr-dia', 'worktrees', repo, `pr-${number}`);
    progress(`git worktree ${branch}`);
    addGitWorktree(located.dir, cwd, branch);
    const tab = await call('tab.create', { workspace_id: workspaceId, cwd, env, label: `${agentSlug(repo)}#${number} update`, focus: Boolean(focus) });
    tabId = tab.tab?.tab_id;
    paneId = tab.root_pane?.pane_id || (await call('pane.list', { workspace_id: workspaceId })).panes.slice(-1)[0].pane_id;
    recordWorktree({ id: tabId, workspaceId, tabId, owner, repo, number, branch, checkoutPath: cwd, sourceCheckout: located.dir });
  } else {
    progress('tab in herdr-dia');
    const tab = await call('tab.create', { workspace_id: workspaceId, cwd, env, label: `${agentSlug(repo)}#${number} ${mode === 'review' ? 'review' : 'update'}`, focus: Boolean(focus) });
    tabId = tab.tab?.tab_id;
    paneId = tab.root_pane?.pane_id || (await call('pane.list', { workspace_id: workspaceId })).panes.slice(-1)[0].pane_id;
  }

  // Retire any empty CLI tab now that a real session tab exists (covers a freshly-created
  // workspace and any stray root tab left by an earlier run).
  await sweepEmptyTabs(workspaceId, tabId);

  // Reviews default to Claude Code's plan mode: the agent can read but not act, the review
  // is its plan, and the human decides what happens next. Other agent kinds don't have an
  // equivalent flag, so they get the posting brief instead.
  const planMode = mode === 'review' && p.planMode !== false && kind === 'claude';
  const args = planMode ? ['--permission-mode', 'plan'] : [];

  const name = agentName(mode, repo, number);
  progress(`starting ${kind} as ${name}${planMode ? ' (plan mode)' : ''}`);
  await startAgent({ name, kind, paneId, args });
  progress(`waiting for ${name} to be ready`);
  await waitForAgent(name, kind, { onProgress: progress });

  progress(`sending the ${mode} brief`);
  const text = mode === 'review'
    ? (planMode ? planReviewBrief({ owner, repo, number, url, title, instruction }) : reviewBrief({ owner, repo, number, url, title, instruction, resultFile }))
    : implementBrief({ owner, repo, number, url, title, instruction, existing: located.existing });
  await call('agent.prompt', { target: name, text, wait: null });
  if (p.threadId) { progress('marking the notification read'); await markRead(p.threadId, p); }

  recordSession({ agentName: name, owner, repo, number, mode, planMode, url: url || `https://github.com/${owner}/${repo}/pull/${number}`, title, workspaceId, tabId });
  send({ id, result: { type: 'launched', mode, planMode, name, kind, workspace_id: workspaceId, pane_id: paneId, cwd, existing: located.existing, resultFile } });
}

log('host started', SOCKET);
