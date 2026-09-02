// The panel's decisions, with no DOM and no chrome APIs: what a status means, what a row
// says, whether a merge button is live, whether the queue actually changed. panel.js
// imports these and does the rendering; the test suite imports them directly.

// The GitHub notification reasons the queue shows, in the words the panel uses.
export const REASONS = {
  review_requested: 'review requested', mention: 'mentioned you', assign: 'assigned to you',
  team_mention: 'team mentioned', author: 'your PR', comment: 'new comment',
  state_change: 'state changed', ci_activity: 'CI', approval_requested: 'approval requested',
};

// Sort order for the Active board when nothing is review-ready: whoever needs a human first.
export const SESSION_ORDER = { blocked: 1, working: 2, unknown: 3, idle: 4, done: 5, gone: 6 };

// How long `idle` has to hold before it counts as "the agent finished".
export const IDLE_READY_MS = 45_000;

// agent name -> when it was first seen idle in its current stretch
export const idleSince = new Map();

// Herdr says `done` when Claude Code finishes a turn — that is "review ready". `idle` also
// appears mid-turn (waiting on a fetch, between tool calls), so treat it as ready only
// after it has held for a while.
export function settled(agent, now = Date.now()) {
  if (!agent) return false;
  if (agent.status === 'done') return true;
  // A plan-mode reviewer that finished sits blocked on Claude's exit-plan dialog; the host
  // dismisses that when the review is read, so treat it as ready.
  if (agent.status === 'blocked' && agent.mode === 'review') return true;
  if (agent.status !== 'idle') { idleSince.delete(agent.name); return false; }
  if (!idleSince.has(agent.name)) idleSince.set(agent.name, now);
  return now - idleSince.get(agent.name) >= IDLE_READY_MS;
}

export function sessionReady(s, now = Date.now()) {
  return s.mode === 'review' && settled({ name: s.agentName, status: s.status, mode: s.mode }, now);
}

export function sessionStatusWord(s, now = Date.now()) {
  if (s.status === 'gone') return 'finished';
  if (sessionReady(s, now)) return 'review ready';
  if (s.status === 'blocked') return 'needs you';
  if (s.status === 'working' || s.status === 'unknown' || (s.status === 'idle' && s.mode === 'review')) return s.mode === 'review' ? 'reviewing…' : 'updating…';
  if (s.status === 'done') return 'done';
  return s.status;
}

// A compact fingerprint of everything the queue renders, so a periodic refresh can skip an
// identical re-render (which would flicker, lose the scroll position, and disarm a merge).
export function queueSignature(tiers) {
  const one = (pr) => `${pr.owner}/${pr.repo}#${pr.number}:${pr.reviewDecision ?? ''}:${pr.mergeable ?? ''}:${pr.agent ? pr.agent.status : ''}:${pr.result ? 'r' : ''}`;
  return JSON.stringify({
    f: (tiers.favorites || []).map(one),
    m: (tiers.mine || []).map(one),
    b: (tiers.brief || []).map(one),
    t: (tiers.team || []).map(one),
    o: (tiers.other || []).map((x) => x.url || x.title),
  });
}

// A repository name, reduced the same way the host reduces it (host/lib.mjs).
export function agentSlug(repo) {
  return String(repo || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------- current tab → PR
export const PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePrUrl(url, title = '') {
  const match = url ? PR_RE.exec(url) : null;
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]), url: match[0], title: cleanTitle(title) };
}

export function cleanTitle(title = '') {
  return title.replace(/\s+by\s+\S+\s+·\s+Pull Request.*$/i, '').replace(/\s*·\s*GitHub$/i, '').trim();
}

export function shortPath(p) {
  return p ? p.replace(/^\/Users\/[^/]+/, '~') : '';
}

// ---------------------------------------------------------------- your own PRs
// Mine PRs carry a reviewDecision (from GraphQL); that is what the badge reports.
export function approvalState(pr) {
  if (pr.reviewDecision === undefined) return null;
  if (pr.reviewDecision === 'APPROVED') return { cls: 'ok', text: '✓ approved' };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { cls: 'changes', text: '± changes requested' };
  return { cls: 'pending', text: 'review pending' };
}

// The merge button is live only for a PR that is both approved and mergeable; otherwise it
// says why it isn't.
export function mergeState(pr) {
  const approved = pr.reviewDecision === 'APPROVED';
  const mergeable = pr.mergeable === 'MERGEABLE';
  if (!approved) return { enabled: false, title: 'waiting for approval' };
  if (!mergeable) return { enabled: false, title: `not mergeable (${String(pr.mergeable || 'unknown').toLowerCase()})` };
  return { enabled: true, title: '' };
}

// The follow-up brief for "Fix these": the review's findings, as instructions.
export function fixInstruction(result) {
  const lines = (result.findings || []).map((f) => `- [${f.severity || '?'}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}${f.title || ''}${f.suggestion ? `: ${f.suggestion}` : ''}`);
  return [
    'Address these findings from the agent review:',
    ...lines,
    result.comment_url ? `The full review is at ${result.comment_url}.` : '',
  ].filter(Boolean).join('\n');
}
