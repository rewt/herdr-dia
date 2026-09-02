// Panel: owns the native messaging port for as long as it is open.
// Herdr and GitHub keep the real state; this page is a view plus a few buttons.

import {
  REASONS, SESSION_ORDER, settled, sessionReady, sessionStatusWord, queueSignature,
  agentSlug, parsePrUrl, shortPath, approvalState, mergeState, fixInstruction,
} from './logic.js';

const HOST = 'com.herdr.dia_bridge';
const $ = (id) => document.getElementById(id);

let port = null;
let seq = 0;
const pending = new Map();
let agents = [];
let queue = [];
let tiers = { favorites: [], mine: [], brief: [], team: [], other: [] };
let currentPr = null;
let subscribedPanes = '';
const settings = { reposRoot: '', ghConfigDir: '', claudeConfigDir: '', kind: 'claude', planMode: true, focus: false, repos: [], favorites: [], onlyUnapproved: true, mineState: 'open' };
let knownRepos = [];
let knownAuthors = [];
let sessionsList = [];
const reviews = new Map(); // reviewer agent name -> { text, result } once the user opened it

// ---------------------------------------------------------------- host connection
function connect() {
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (error) {
    return setConn('bad', `no host: ${error.message}`);
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message || 'host exited';
    setConn('bad', why);
    port = null;
    for (const [, p] of pending) p.reject(new Error(why));
    pending.clear();
    renderPr();
  });
  request('dia.hello').then((hello) => {
    setConn('ok', hello.socket.replace(hello.home, '~'));
    renderPr();
    refreshAgents();
    refreshQueue();
    refreshSessions();
    loadConfig();
  }).catch((error) => setConn('bad', error.message));
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('not connected'));
    const id = `p${++seq}`;
    pending.set(id, { resolve, reject, onProgress: params.__onProgress });
    delete params.__onProgress;
    port.postMessage({ id, method, params });
  });
}

function onHostMessage(message) {
  if (message.subscription) return onEvent(message);
  const p = pending.get(message.id);
  if (!p) return;
  if (message.progress !== undefined) return p.onProgress?.(message.progress);
  pending.delete(message.id);
  if (message.error) p.reject(Object.assign(new Error(message.error.message || 'error'), { herdr: message.error }));
  else p.resolve(message.result);
}

function setConn(state, text) {
  const el = $('conn');
  el.className = `conn ${state}`;
  el.textContent = text;
}

function launchParams(extra) {
  return {
    kind: settings.kind,
    focus: settings.focus === true,
    planMode: settings.planMode !== false,
    reposRoot: settings.reposRoot || undefined,
    ghConfigDir: settings.ghConfigDir || undefined,
    claudeConfigDir: settings.claudeConfigDir || undefined,
    ...extra,
  };
}

// ---------------------------------------------------------------- review queue
async function refreshQueue() {
  if (!port) return;
  try {
    const result = await request('dia.queue', {
      reposRoot: settings.reposRoot || undefined,
      ghConfigDir: settings.ghConfigDir || undefined,
      repos: settings.repos.length ? settings.repos : undefined,
      favorites: settings.favorites.length ? settings.favorites : undefined,
      onlyUnapproved: settings.onlyUnapproved !== false,
      mineState: settings.mineState === 'closed' ? 'closed' : 'open',
    });
    tiers = { favorites: result.favorites || [], mine: result.mine || [], brief: result.brief || [], team: result.team || [], other: result.other || [] };
    queue = result.prs || [];
    if (result.knownRepos) { knownRepos = result.knownRepos; if (!$('settings').hidden) renderRepoChips(); }
    if (result.knownAuthors) { knownAuthors = result.knownAuthors; if (!$('settings').hidden) renderAuthorChips(); }
    $('queue-note').className = 'hint';
    const notes = [];
    if (settings.repos.length) notes.push(`${settings.repos.length} repo${settings.repos.length === 1 ? '' : 's'}`);
    if (settings.onlyUnapproved) notes.push('unapproved');
    $('queue-note').textContent = notes.length ? `filtered to ${notes.join(' · ')}` : '';
    // Only re-render when the queue actually changed — otherwise a periodic refresh would
    // rebuild the rows (flicker, lost scroll, a half-armed merge reset) for no reason.
    const sig = queueSignature(tiers);
    if (sig !== lastQueueSig) { lastQueueSig = sig; renderQueue(); }
  } catch (error) {
    $('queue-note').className = 'hint error';
    $('queue-note').textContent = error.message;
  }
}

// The last fingerprint rendered, so an unchanged queue is left alone.
let lastQueueSig = '';

let queueTab = 'favorites';
// Tabs stay put once seen this session, so a tier momentarily emptying (or a PR you just
// opened) never drops its tab or bounces you to another one.
const queueSeen = new Set();

function renderQueue() {
  if (panelTyping()) return;
  const list = $('queue');
  list.textContent = '';
  $('queue-count').textContent = '';

  const order = [
    ['favorites', 'Favorites', tiers.favorites || []],
    ['mine', 'Mine', tiers.mine || []],
    ['brief', 'Brief', tiers.brief || []],
    ['team', 'Team', tiers.team || []],
    ['other', 'Other', tiers.other || []],
  ];
  for (const [key, , arr] of order) if (arr.length) queueSeen.add(key);
  // Show a tab if it has content now, has had content this session, or is the one you're on.
  const defs = order.filter(([key, , arr]) => arr.length || queueSeen.has(key) || key === queueTab);

  if (!defs.length) { list.append(emptyRow('Nothing waiting on you.')); return; }
  if (!defs.some(([key]) => key === queueTab)) queueTab = defs[0][0];

  const bar = document.createElement('div');
  bar.className = 'tabbar';
  for (const [key, label, arr] of defs) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `tab${key === queueTab ? ' active' : ''}`;
    const n = document.createElement('span');
    n.className = 'tab-n';
    n.textContent = arr.length;
    tab.append(document.createTextNode(label + ' '), n);
    tab.addEventListener('click', () => { queueTab = key; renderQueue(); });
    bar.append(tab);
  }
  list.append(bar);

  const body = document.createElement('ul');
  body.className = 'queue';
  renderTier(queueTab, body);
  if (!body.childElementCount) body.append(emptyRow(`No ${defs.find(([k]) => k === queueTab)?.[1] || 'items'} right now.`));
  list.append(body);
}

function renderTier(key, body) {
  if (key === 'favorites') {
    let lastAuthor = null;
    for (const pr of tiers.favorites) {
      if (pr.author !== lastAuthor) { body.append(tierHeading(`@${pr.author}`, true)); lastAuthor = pr.author; }
      body.append(renderPrRow(pr));
    }
  } else if (key === 'mine') {
    body.append(renderMineToggle());
    for (const pr of tiers.mine) body.append(renderPrRow(pr));
    if (!tiers.mine.length) body.append(emptyRow(settings.mineState === 'closed' ? 'No closed PRs.' : 'No open PRs of yours.'));
  } else if (key === 'brief') {
    for (const pr of tiers.brief) body.append(renderPrRow(pr));
  } else if (key === 'team') {
    let lastRepo = null;
    for (const pr of tiers.team) {
      if (pr.repo !== lastRepo) { body.append(tierHeading(`${pr.owner}/${pr.repo}`, true)); lastRepo = pr.repo; }
      body.append(renderPrRow(pr));
    }
  } else if (key === 'other') {
    for (const item of tiers.other) {
      const li = document.createElement('li');
      li.className = 'pr other';
      const ref = document.createElement('div');
      ref.className = 'ref';
      ref.textContent = `${item.repo || ''}${item.reason ? ` · ${REASONS[item.reason] || item.reason}` : ''}`;
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title || item.type || '';
      li.append(ref, title);
      if (item.url) li.addEventListener('click', () => chrome.tabs.create({ url: item.url }));
      body.append(li);
    }
  }
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

// Open/Closed switch shown at the top of the Mine tab.
function renderMineToggle() {
  const li = document.createElement('li');
  li.className = 'mine-toggle';
  for (const [state, label] of [['open', 'Open'], ['closed', 'Closed']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `seg${settings.mineState === state ? ' active' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => { if (settings.mineState !== state) saveField('mineState', state, refreshQueue); });
    li.append(b);
  }
  return li;
}

function tierHeading(text, sub = false) {
  const li = document.createElement('li');
  li.className = `tier-heading${sub ? ' sub' : ''}`;
  li.textContent = text;
  return li;
}


// The state line + action buttons for a PR, shared by the queue rows and the This-tab card.
// includeDispatch adds the "Review on my behalf" starter (queue only; This-tab has its own
// buttons). Returns null when there's nothing to show (no agent, no result).
function buildPrState(pr, includeDispatch, opts = {}) {
  const reviewReady = Boolean(pr.agent && pr.agent.mode === 'review' && settled(pr.agent));
  const blocked = Boolean(pr.agent && pr.agent.status === 'blocked' && !reviewReady);
  const busy = Boolean(pr.agent && !blocked && !reviewReady && (pr.agent.mode === 'review' || ['working', 'unknown'].includes(pr.agent.status)));
  if (!pr.agent && !pr.result && !includeDispatch) return null;
  const focusAgent = () => request('agent.focus', { target: pr.agent.name }).catch(showError);

  const state = document.createElement('div');
  state.className = 'state';
  if (!opts.noLabel) {
    const label = document.createElement('span');
    label.className = 'lbl';
    if (busy) label.textContent = `${pr.agent.mode === 'review' ? 'reviewing' : 'updating'}…`;
    else if (blocked) label.textContent = 'needs you in Herdr';
    else if (reviewReady && !pr.result) { label.textContent = 'review ready'; label.classList.add('ready'); }
    else if (pr.result) label.textContent = `reviewed · ${pr.result.findings?.length || 0} finding${(pr.result.findings?.length || 0) === 1 ? '' : 's'}`;
    else label.textContent = 'awaiting review';
    state.append(label);
  }

  if (busy || blocked) {
    if (pr.agent.mode === 'review') state.append(smallButton(reviews.has(pr.agent.name) ? 'Hide' : 'Peek', () => toggleReview(pr), true));
    state.append(smallButton('Open in Herdr', focusAgent));
  } else if (reviewReady) {
    state.append(smallButton(reviews.has(pr.agent.name) ? 'Hide review' : 'Read review', () => toggleReview(pr), false));
    state.append(smallButton('Open in Herdr', focusAgent, true));
  } else if (pr.result) {
    state.append(
      smallButton('Fix these', () => dispatch(pr, 'implement', fixInstruction(pr.result)), false),
      smallButton('Review again', () => dispatch(pr, 'review', ''), true),
    );
    if (pr.result.comment_url) state.append(smallButton('Comment', () => chrome.tabs.create({ url: pr.result.comment_url }), true));
  } else if (includeDispatch) {
    state.append(smallButton('Review on my behalf', () => dispatch(pr, 'review', ''), false));
  }
  return state;
}

function appendReviewBits(pr, container) {
  const review = pr.agent ? reviews.get(pr.agent.name) : null;
  const shown = review?.result || pr.result;
  if (shown?.findings?.length) container.append(renderFindings(shown.findings));
  else if (shown?.summary) {
    const summary = document.createElement('div');
    summary.className = 'hint';
    summary.textContent = shown.summary;
    container.append(summary);
  }
  if (review) container.append(renderReviewBlock(pr, review));
}

function renderPrRow(pr) {
  const li = document.createElement('li');
  li.className = 'pr';
  const head = document.createElement('div');
  head.className = 'head';
  const dot = document.createElement('span');
  dot.className = `dot ${pr.agent ? pr.agent.status : (pr.result ? 'reviewed' : 'idle')}`;
  const text = document.createElement('div');
  const ref = document.createElement('div');
  ref.className = 'ref';
  ref.textContent = `${pr.owner}/${pr.repo}#${pr.number}${pr.author ? ` · ${pr.author}` : ''}${pr.reason ? ` · ${REASONS[pr.reason] || pr.reason}` : ''}`;
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = pr.title;
  text.append(ref, title);
  const badge = approvalBadge(pr);
  if (badge) text.append(badge);
  head.append(dot, text);
  li.append(head);
  const state = buildPrState(pr, true);
  if (pr.reviewDecision !== undefined) state.append(mergeButton(pr)); // mine PRs carry a review decision
  state.append(smallButton('PR', () => chrome.tabs.create({ url: pr.url }), true));
  li.append(state);
  appendReviewBits(pr, li);
  return li;
}

// mine PRs carry reviewDecision (from GraphQL); show the approval state as a badge.
function approvalBadge(pr) {
  const state = approvalState(pr);
  if (!state) return null;
  const b = document.createElement('div');
  b.className = `approval ${state.cls}`;
  b.textContent = state.text;
  return b;
}

// A merge button for your own PR, enabled only once it's approved and mergeable. Two clicks
// (Merge → Confirm) so it can't fire by accident; merging goes to the base branch for real.
const mergeArmed = new Set();
function mergeButton(pr) {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`;
  const merge = mergeState(pr);
  const armed = mergeArmed.has(key);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `pill small merge${armed ? ' confirm' : ''}`;
  btn.textContent = armed ? 'Confirm merge' : 'Merge';
  btn.disabled = !merge.enabled;
  if (merge.title) btn.title = merge.title;
  btn.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!mergeArmed.has(key)) {
      mergeArmed.add(key);
      renderQueue();
      setTimeout(() => { if (mergeArmed.delete(key)) renderQueue(); }, 4000);
      return;
    }
    mergeArmed.delete(key);
    btn.disabled = true;
    btn.textContent = 'merging…';
    try {
      const result = await request('dia.merge_pr', { owner: pr.owner, repo: pr.repo, number: pr.number, ghConfigDir: settings.ghConfigDir || undefined });
      showProgress(`merged ${key} (${result.method})`);
      refreshQueue();
    } catch (error) {
      showError(error);
      renderQueue();
    }
  });
  return btn;
}

function renderFindings(findings) {
  const list = document.createElement('ul');
  list.className = 'findings';
  for (const f of findings) {
    const row = document.createElement('li');
    row.className = 'finding';
    const sev = document.createElement('span');
    sev.className = `sev ${String(f.severity || '').toLowerCase()}`;
    sev.textContent = f.severity || '?';
    const body = document.createElement('span');
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : '';
    body.append(where, document.createTextNode(f.title || f.suggestion || ''));
    body.title = f.suggestion || '';
    row.append(sev, body);
    list.append(row);
  }
  return list;
}

// The plan-mode review lives in the agent's pane. Read it on demand, then let the user
// answer the agent from here (or in Herdr — same conversation).
async function toggleReview(pr) {
  const name = pr.agent.name;
  if (reviews.has(name)) { reviews.delete(name); renderQueue(); renderSessions(); return; }
  try {
    reviews.set(name, await request('dia.review_text', { name }));
    renderQueue();
    renderSessions();
    refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function renderReviewBlock(pr, review) {
  // A reconstructed session may not know its owner/repo yet; the review carries the full ref.
  const ref = /^([^/]+)\/([^#]+)#(\d+)$/.exec(review.result?.pr || '');
  if (ref && (!pr.owner || !pr.repo)) { pr.owner = ref[1]; pr.repo = ref[2]; pr.number = Number(ref[3]); }
  const block = document.createElement('div');
  block.className = 'review';
  if (review.result?.recommendation) {
    const rec = document.createElement('div');
    rec.className = 'rec';
    rec.textContent = `recommendation: ${review.result.recommendation}`;
    block.append(rec);
  }
  const pre = document.createElement('pre');
  pre.textContent = review.text || '(the agent has not written anything yet)';
  block.append(pre);

  const row = document.createElement('div');
  row.className = 'instruct';
  const input = document.createElement('input');
  input.placeholder = 'Tell the agent how to proceed…';
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') instruct(pr, input.value); });
  row.append(input, smallButton('Send', () => instruct(pr, input.value), false));
  block.append(row);

  const quick = document.createElement('div');
  quick.className = 'quick';
  quick.append(
    smallButton('Post as comment', () => instruct(pr, `Post this review as a comment on the PR: write it to review.md and run gh pr review ${pr.number} --repo ${pr.owner}/${pr.repo} --comment --body-file review.md. Begin the comment with "Agent review (herdr-dia)". Do not approve or request changes.`), true),
    smallButton('Apply the fixes', () => instruct(pr, `Apply the fixes you recommended: clone ${pr.owner}/${pr.repo} into this directory if it is not a checkout yet, run gh pr checkout ${pr.number}, make the changes, commit in the style of the branch's existing commits, and push to the PR branch.`), true),
    smallButton('Refresh', () => { reviews.delete(pr.agent.name); toggleReview(pr); }, true),
  );
  block.append(quick);
  return block;
}

async function instruct(pr, text) {
  if (!text?.trim()) return;
  // Blur the input first so the post-send re-render isn't suppressed by panelTyping().
  try { document.activeElement?.blur?.(); } catch { /* ignore */ }
  try {
    showProgress(`sending to ${pr.agent.name}…`);
    const result = await request('dia.proceed', { name: pr.agent.name, text: text.trim(), __onProgress: (t) => showProgress(t) });
    showProgress(result.approved ? `${pr.agent.name} is acting on it (left plan mode)` : `${pr.agent.name} has the instruction`);
    reviews.delete(pr.agent.name);
    refreshAgents();
    refreshQueue();
    refreshSessions();
  } catch (error) {
    showError(error);
  }
}

function smallButton(text, onClick, secondary = false) {
  const b = document.createElement('button');
  b.className = `small${secondary ? ' secondary' : ''}`;
  b.textContent = text;
  b.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
  return b;
}

async function dispatch(pr, mode, instruction) {
  showProgress(`${mode === 'review' ? 'review' : 'update'} ${pr.owner}/${pr.repo}#${pr.number}…`);
  try {
    const result = await request('dia.launch', launchParams({
      owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url, title: pr.title, instruction, mode,
      threadId: mode === 'review' ? pr.threadId : undefined,
      __onProgress: (text) => showProgress(text),
    }));
    showProgress(`launched ${result.name}${result.planMode ? ' in plan mode' : ''} in ${shortPath(result.cwd)}`);
    refreshAgents();
    refreshQueue();
    refreshSessions();
  } catch (error) {
    showError(error);
  }
}

// ---------------------------------------------------------------- agents
async function refreshAgents() {
  if (!port) return;
  try {
    const result = await request('agent.list');
    agents = result.agents || [];
    renderSessions();
    resubscribe();
  } catch (error) {
    setConn('bad', error.message);
  }
}

function resubscribe() {
  const paneIds = agents.map((a) => a.pane_id).sort();
  const key = paneIds.join(',');
  if (key === subscribedPanes) return;
  subscribedPanes = key;
  const subscriptions = [
    { type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.exited' }, { type: 'pane.agent_detected' },
    { type: 'workspace.created' }, { type: 'workspace.closed' }, { type: 'workspace.updated' }, { type: 'workspace.focused' },
    ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
  ];
  request('dia.subscribe', { subscriptions }).catch(() => {});
}

function onEvent(message) {
  // Herdr spells lifecycle event types with underscores (pane_agent_detected) and
  // subscription kinds with dots (pane.agent_status_changed); accept either.
  const kind = String(message.event || message.data?.type || '');
  if (/agent_status_changed$/.test(kind) && message.data?.pane_id) {
    const agent = agents.find((a) => a.pane_id === message.data.pane_id);
    if (agent) { agent.agent_status = message.data.agent_status; renderSessions(); }
    const tracked = queue.find((pr) => pr.agent?.pane_id === message.data.pane_id);
    if (tracked) refreshQueue();
    return;
  }
  refreshAgents();
}

// The Active board: one collapsible row per session the extension launched (any repo), each
// with live status. Session context (owner/repo/title/result) comes from dia.sessions and is
// self-healing (see the host); live status is overlaid from the local agent list so it updates
// on every event without a round-trip. Click a row to expand its actions and review.
const expandedSessions = new Set();
const autoExpandedReady = new Set();

// Don't rebuild the board or queue out from under a text field the user is typing in — a
// periodic status refresh would otherwise destroy the input and lose what they've typed.
function panelTyping() {
  const el = document.activeElement;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
  return $('agents').contains(el) || $('queue').contains(el);
}

function renderSessions() {
  if (panelTyping()) return;
  const list = $('agents');
  list.textContent = '';
  const shown = sessionsList.map((s) => {
    const a = agents.find((x) => x.name === s.agentName);
    return { ...s, status: a?.agent_status || 'gone', paneId: a?.pane_id || s.paneId || null };
  });
  $('agent-count').textContent = shown.length ? `· ${shown.length}` : '';
  $('active-card').hidden = shown.length === 0;
  // Expand a session the first time it becomes review-ready, so the actions are right there.
  for (const s of shown) if (sessionReady(s) && !autoExpandedReady.has(s.agentName)) { autoExpandedReady.add(s.agentName); expandedSessions.add(s.agentName); }
  shown.sort((a, b) => (sessionReady(b) - sessionReady(a)) || ((SESSION_ORDER[a.status] || 9) - (SESSION_ORDER[b.status] || 9)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  for (const s of shown) list.append(renderSessionRow(s));
}

function renderSessionRow(s) {
  const ready = sessionReady(s);
  const expanded = expandedSessions.has(s.agentName);
  const li = document.createElement('li');
  li.className = 'session';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'session-head';
  const dot = document.createElement('span');
  dot.className = `dot ${ready ? 'reviewed' : s.status}`;
  const text = document.createElement('div');
  text.className = 'session-text';
  const ref = document.createElement('span');
  ref.className = 'ref';
  ref.textContent = `${agentSlug(s.repo)}#${s.number}`;
  const st = document.createElement('span');
  st.className = `session-status${ready ? ' ready' : ''}`;
  st.textContent = `${s.mode === 'review' ? 'review' : 'update'} · ${sessionStatusWord(s)}`;
  text.append(ref, st);
  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = expanded ? '▾' : '▸';
  head.append(dot, text, chev);
  head.addEventListener('click', () => { if (expanded) expandedSessions.delete(s.agentName); else expandedSessions.add(s.agentName); renderSessions(); });
  li.append(head);

  if (expanded) {
    const body = document.createElement('div');
    body.className = 'session-body';
    const pr = {
      owner: s.owner, repo: s.repo, number: s.number, url: s.url, title: s.title, result: s.result || null,
      agent: s.status === 'gone' ? null : { name: s.agentName, status: s.status, mode: s.mode, pane_id: s.paneId },
    };
    let state = buildPrState(pr, false, { noLabel: true });
    if (!state) { state = document.createElement('div'); state.className = 'state'; }
    if (s.url) state.append(smallButton('PR', () => chrome.tabs.create({ url: s.url }), true));
    if (s.status === 'gone') state.append(smallButton('Dismiss', () => dismissSession(s.agentName), true));
    else state.append(smallButton('End', () => endSession(s.agentName), true));
    if (state.childElementCount) body.append(state);
    appendReviewBits(pr, body);
    li.append(body);
  }
  return li;
}

async function dismissSession(agentName) {
  try { await request('dia.dismiss_session', { agentName }); refreshSessions(); } catch (error) { showProgress(error.message, true); }
}

async function endSession(agentName) {
  try {
    await request('dia.end_session', { agentName });
    reviews.delete(agentName);
    expandedSessions.delete(agentName);
    autoExpandedReady.delete(agentName);
    showProgress('session closed');
    refreshAgents();
    refreshSessions();
  } catch (error) {
    showProgress(error.message, true);
  }
}

async function refreshSessions() {
  if (!port) return;
  try { const result = await request('dia.sessions'); sessionsList = result.sessions || []; } catch { /* keep last */ }
  renderSessions();
}

// ---------------------------------------------------------------- current tab → PR
async function readCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    currentPr = parsePrUrl(tab?.url, tab?.title || '');
  } catch {
    currentPr = null;
  }
  renderPr();
}

function renderPr() {
  if (currentPr) {
    $('pr-title').textContent = currentPr.title || `Pull request #${currentPr.number}`;
    $('pr-ref').textContent = `${currentPr.owner}/${currentPr.repo}#${currentPr.number}`;
  } else {
    $('pr-title').textContent = 'Open a GitHub pull request in this window.';
    $('pr-ref').textContent = '';
  }
  const ready = Boolean(currentPr && port);
  $('launch').disabled = !ready;
  $('review').disabled = !ready;
}

chrome.tabs.onActivated.addListener(readCurrentTab);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.title || info.status === 'complete') readCurrentTab(); });
if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(readCurrentTab);

$('review').addEventListener('click', () => { if (currentPr) dispatch(currentPr, 'review', $('instruction').value); });
$('launch').addEventListener('click', () => { if (currentPr) dispatch(currentPr, 'implement', $('instruction').value); });

function showProgress(text, isError = false) {
  const el = $('progress');
  el.className = `progress${isError ? ' error' : ''}`;
  el.textContent = text;
}

function showError(error) {
  showProgress(error.herdr ? `${error.herdr.code || 'error'}: ${error.message}` : error.message, true);
}

// ---------------------------------------------------------------- settings sheet
$('gear').addEventListener('click', () => { $('settings').hidden = false; refreshWorktrees(); });
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; });

function option(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

// Populate the dropdowns from what actually exists on this machine (dia.config), then
// restore the saved selections.
async function loadConfig() {
  let cfg = { identities: [], agents: [], claudeConfigs: [] };
  try { cfg = await request('dia.config'); } catch (error) { showProgress(error.message, true); }

  const saved = await chrome.storage.local.get(['reposRoot', 'ghConfigDir', 'claudeConfigDir', 'kind', 'planMode', 'focus', 'repos', 'favorites', 'onlyUnapproved', 'mineState']);
  Object.assign(settings, saved);
  $('repos-root').value = settings.reposRoot || '';
  $('focus').checked = settings.focus === true;
  $('unapproved').checked = settings.onlyUnapproved !== false;
  $('review-mode').value = settings.planMode === false ? 'auto' : 'plan';
  renderRepoChips();
  renderAuthorChips();

  const gh = $('gh-config');
  gh.textContent = '';
  gh.append(option('', 'Default (gh)', !settings.ghConfigDir));
  for (const i of cfg.identities) {
    if (i.isDefault) continue;
    gh.append(option(i.dir, `${i.account || '?'} · ${i.name}`, settings.ghConfigDir === i.dir));
  }

  const claude = $('claude-config');
  claude.textContent = '';
  claude.append(option('', 'Default (~/.claude)', !settings.claudeConfigDir));
  for (const c of cfg.claudeConfigs) {
    if (c.isDefault) continue;
    claude.append(option(c.dir, c.name, settings.claudeConfigDir === c.dir));
  }

  const kind = $('kind');
  kind.textContent = '';
  const kinds = cfg.agents.length ? cfg.agents : [{ kind: 'claude' }, { kind: 'codex' }, { kind: 'gemini' }];
  for (const a of kinds) kind.append(option(a.kind, a.version ? `${a.kind} · ${a.version}` : a.kind, settings.kind === a.kind));
  if (!kinds.some((a) => a.kind === settings.kind)) settings.kind = kinds[0].kind;
}

function saveField(key, value, extra = () => {}) {
  settings[key] = value;
  chrome.storage.local.set({ [key]: value });
  extra();
}
// The repo chips are built from the repos the queue has seen (plus any saved selection not
// currently visible), so the filter can be edited without a PR from that repo being present.
function renderRepoChips() {
  const box = $('repos');
  if (!box) return;
  box.textContent = '';
  const all = [...new Set([...knownRepos, ...settings.repos])].sort();
  if (!all.length) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = 'No repositories seen yet.'; box.append(s); return; }
  for (const repo of all) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = repo;
    chip.title = repo;
    chip.setAttribute('aria-pressed', settings.repos.includes(repo) ? 'true' : 'false');
    chip.addEventListener('click', () => {
      const next = new Set(settings.repos);
      next.has(repo) ? next.delete(repo) : next.add(repo);
      saveField('repos', [...next], () => { renderRepoChips(); refreshQueue(); });
    });
    box.append(chip);
  }
}

// Favorite users — the authors whose PRs are pulled to the top of the queue as your team.
// Chips are built from authors seen in the queue plus any saved favorites not currently present.
function renderAuthorChips() {
  const box = $('authors');
  if (!box) return;
  box.textContent = '';
  const all = [...new Set([...knownAuthors, ...settings.favorites])].sort((a, b) => a.localeCompare(b));
  if (!all.length) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = 'No authors seen yet.'; box.append(s); return; }
  for (const user of all) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = `@${user}`;
    chip.setAttribute('aria-pressed', settings.favorites.includes(user) ? 'true' : 'false');
    chip.addEventListener('click', () => {
      const next = new Set(settings.favorites);
      next.has(user) ? next.delete(user) : next.add(user);
      saveField('favorites', [...next], () => { renderAuthorChips(); refreshQueue(); });
    });
    box.append(chip);
  }
}

// Manually add a favorite by typing a username; resolve it against GitHub first so a typo
// doesn't become a chip that never matches anything.
async function addFavorite() {
  const input = $('author-input');
  const val = input.value.trim();
  if (!val) return;
  const btn = $('author-add');
  btn.disabled = true;
  try {
    const u = await request('dia.resolve_user', { login: val, ghConfigDir: settings.ghConfigDir || undefined });
    input.value = '';
    if (settings.favorites.some((f) => f.toLowerCase() === u.login.toLowerCase())) {
      showProgress(`@${u.login} is already a favorite`);
    } else {
      const next = [...settings.favorites, u.login];
      saveField('favorites', next, () => { renderAuthorChips(); refreshQueue(); });
      showProgress(`added @${u.login}${u.name ? ` (${u.name})` : ''}`);
    }
  } catch (error) {
    showProgress(error.herdr ? error.message : error.message, true);
  } finally {
    btn.disabled = false;
  }
}
$('author-add').addEventListener('click', addFavorite);
$('author-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); addFavorite(); } });

$('unapproved').addEventListener('change', () => saveField('onlyUnapproved', $('unapproved').checked, refreshQueue));
$('repos-root').addEventListener('change', () => saveField('reposRoot', $('repos-root').value.trim(), refreshQueue));
$('gh-config').addEventListener('change', () => saveField('ghConfigDir', $('gh-config').value, refreshQueue));
$('claude-config').addEventListener('change', () => saveField('claudeConfigDir', $('claude-config').value));
$('kind').addEventListener('change', () => saveField('kind', $('kind').value));
$('review-mode').addEventListener('change', () => saveField('planMode', $('review-mode').value === 'plan'));
$('focus').addEventListener('change', () => saveField('focus', $('focus').checked));

// worktrees
async function refreshWorktrees() {
  const list = $('worktrees');
  try {
    const result = await request('dia.worktrees');
    const wts = result.worktrees || [];
    $('wt-count').textContent = wts.length ? `· ${wts.length}` : '';
    list.textContent = '';
    if (!wts.length) { list.append(emptyRow('No update worktrees.')); $('wt-tidy').disabled = true; return; }
    let anyClean = false;
    for (const wt of wts) {
      const li = document.createElement('li');
      li.className = 'wt';
      const left = document.createElement('div');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = `${wt.owner}/${wt.repo}#${wt.number}`;
      const meta = document.createElement('div');
      meta.className = `meta${wt.clean === false ? ' dirty' : ''}`;
      meta.textContent = `${wt.branch} · ${wt.clean === false ? 'uncommitted changes' : wt.clean ? 'clean' : 'unknown'}${wt.open ? ' · open' : ''}`;
      left.append(who, meta);
      const remove = document.createElement('button');
      remove.className = 'pill secondary small';
      remove.textContent = 'Remove';
      remove.disabled = wt.clean === false;
      remove.addEventListener('click', async () => { remove.disabled = true; try { await request('dia.remove_worktree', { id: wt.id }); refreshWorktrees(); refreshQueue(); } catch (e) { showProgress(e.message, true); } });
      li.append(left, remove);
      list.append(li);
      if (wt.clean) anyClean = true;
    }
    $('wt-tidy').disabled = !anyClean;
  } catch (error) {
    list.textContent = '';
    list.append(emptyRow(error.message));
  }
}
$('wt-tidy').addEventListener('click', async () => {
  $('wt-tidy').disabled = true;
  try {
    const { worktrees = [] } = await request('dia.worktrees');
    for (const wt of worktrees.filter((w) => w.clean)) await request('dia.remove_worktree', { id: wt.id }).catch(() => {});
    refreshWorktrees();
    refreshQueue();
  } catch (error) { showProgress(error.message, true); }
});

// ---------------------------------------------------------------- go
connect();
readCurrentTab();
setInterval(() => { if (port) refreshAgents(); }, 5000);
setInterval(() => { if (port) refreshQueue(); }, 20000);
setInterval(() => { if (port) refreshSessions(); }, 8000);
