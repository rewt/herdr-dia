// The parts of the host that are pure functions or single-purpose filesystem/git leaves:
// path resolution, agent naming, the result parser, and the briefs. Kept in their own module
// so the test suite can exercise them directly (bridge.mjs owns the socket and the routes).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function expandHome(p) {
  return String(p).startsWith('~') ? path.join(os.homedir(), String(p).slice(1)) : p;
}

// Where does this repository live? Prefer a checkout that already exists under the repos
// root — <root>/<repo>, <root>/<owner>/<repo>, or one level down (<root>/*/<repo>) — whose
// origin points at owner/repo. Existing checkouts are already trusted by Claude Code and
// carry the tree's identities. Otherwise fall back to <root>/<repo> for a fresh clone.
export function resolveRepoDir(root, owner, repo) {
  const wanted = `${owner}/${repo}`.toLowerCase();
  const candidates = [path.join(root, repo), path.join(root, owner, repo)];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) candidates.push(path.join(root, entry.name, repo));
    }
  } catch {}
  for (const dir of candidates) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    try {
      const origin = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
      if (origin.toLowerCase().includes(wanted)) return { dir, existing: true };
    } catch {}
  }
  return { dir: path.join(root, repo), existing: false };
}

// Review results live in home-level state, never inside anyone's checkout.
export function resultPath(root, owner, repo, number) {
  return path.join(os.homedir(), '.herdr-dia', 'reviews', owner, repo, `${number}.json`);
}

// A repository name, reduced to what an agent name can carry.
export function agentSlug(repo) {
  return String(repo || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// The number comes right after the prefix so #16 and #167 never share a base, and the slug
// keeps different repos distinct. Capped at 26 to leave room for a "-xxxx" random suffix.
// When the name has to be cut, keep the TAIL: a shared prefix at the front is exactly what
// makes two repository names collide, so the end is what tells them apart.
export function agentBase(mode, repo, number) {
  const head = `${mode === 'review' ? 'rv' : 'pr'}-${number}-`;
  const slug = agentSlug(repo);
  const room = 26 - head.length;
  if (room <= 0) return head.slice(0, 26);
  return head + (slug.length <= room ? slug : slug.slice(-room).replace(/^-+/, ''));
}

export function agentName(mode, repo, number) {
  return `${agentBase(mode, repo, number)}-${Math.random().toString(36).slice(2, 6)}`;
}

// The agent names this extension creates, so a live agent can be matched back to its PR.
export const AGENT_NAME_RE = /^(rv|pr)-(\d+)-(.+)-[0-9a-z]{4}$/;

export function readResult(file) {
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...json, file, writtenAt: fs.statSync(file).mtime.toISOString() };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- screen reading
export const PLAN_DIALOG = /Ready to code\?|Would you like to proceed|Here is Claude's plan/i;
export const PERMISSION_PROMPT = /^\s*Do you want to (create|write|edit|make|run|execute|proceed|read|fetch|delete|apply|overwrite)\b/i;

// Pull the HERDR_DIA_RESULT {...} object out of terminal text. The TUI may have wrapped
// the line and indented the continuation, so walk braces (outside strings) and drop the
// newlines/indentation before parsing. Uses the last marker in the text.
export function extractResult(text) {
  const marker = text.lastIndexOf('HERDR_DIA_RESULT');
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let out = '';
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') continue;
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[++i] ?? ''; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    out += ch;
    if (depth === 0) break;
  }
  try { return JSON.parse(out.replace(/\s{2,}/g, ' ')); } catch { return null; }
}

// While parked on the exit-plan dialog, Claude Code shows where it wrote the plan
// ("ctrl+g to edit in Nvim · ~/.claude-personal/plans/<slug>.md"). That file is the full
// review, readable without touching the dialog.
export function planFileFromScreen(screen) {
  const m = /((?:~|\/)[^\s·]*\/plans\/[^\s·]+\.md)/.exec(screen);
  return m ? expandHome(m[1]) : null;
}

// ---------------------------------------------------------------- briefs
// Plan-mode review: the agent may only read. The review is presented as its plan and the
// human decides what happens next (post it, apply fixes, or nothing).
export function planReviewBrief({ owner, repo, number, url, title, instruction }) {
  const link = url || `https://github.com/${owner}/${repo}/pull/${number}`;
  const at = `--repo ${owner}/${repo}`;
  return [
    `You are reviewing GitHub pull request ${owner}/${repo}#${number}${title ? ` — "${title}"` : ''} (${link}) on my behalf. You are in plan mode: read and analyze only. Do not post, edit, clone, or write anything.`,
    `Read it with: gh pr view ${number} ${at} --comments; gh pr diff ${number} ${at}; gh pr checks ${number} ${at}. If you need surrounding code, fetch files with gh api (repos/${owner}/${repo}/contents/<path>?ref=<branch>) rather than cloning.`,
    'Review for correctness, security, and anything CI or the existing review comments already flag. Be specific: file and line, what is wrong, why it matters, what to do instead. Skip style nits unless they hide a real problem.',
    instruction.trim() ? `Focus: ${instruction.trim()}` : '',
    'Present the review as your plan, in this order: (1) a one-paragraph summary and your recommendation — approve, request changes, or comment only; (2) the findings, each with severity high|medium|low, file:line, the problem, and the fix; (3) the actions you could take next, as separate options: post the review as a PR comment, apply specific fixes on the branch.',
    `End the plan with exactly one line of compact JSON, no line breaks: HERDR_DIA_RESULT {"pr":"${owner}/${repo}#${number}","summary":"<one sentence>","recommendation":"approve|request-changes|comment","findings":[{"severity":"high|medium|low","file":"<path>","line":<number or null>,"title":"<short>","suggestion":"<what to do instead>"}]}`,
    'Then stop and wait. I will read the review and tell you how to proceed.',
  ].filter(Boolean).join('\n');
}

export function reviewBrief({ owner, repo, number, url, title, instruction, resultFile }) {
  const link = url || `https://github.com/${owner}/${repo}/pull/${number}`;
  const at = `--repo ${owner}/${repo}`;
  return [
    `You are reviewing GitHub pull request ${owner}/${repo}#${number}${title ? ` — "${title}"` : ''} (${link}) on my behalf.`,
    `Read it without cloning: gh pr view ${number} ${at} --comments, gh pr diff ${number} ${at}, and gh pr checks ${number} ${at}. Clone into this directory only if you need to run something (gh repo clone ${owner}/${repo} .).`,
    'Review for correctness, security, and anything CI or the existing review comments already flag. Be specific: file and line, what is wrong, what to do instead. Skip style nits unless they hide a real problem.',
    instruction.trim() ? `Focus: ${instruction.trim()}` : '',
    'When you are done, do both of these:',
    `1. Post the review as a comment — not an approval and not a change request. Write it to review.md in this directory, then run: gh pr review ${number} ${at} --comment --body-file review.md. Begin the comment with "Agent review (herdr-dia)".`,
    `2. Write a JSON summary to ${resultFile} with exactly this shape: {"pr":"${owner}/${repo}#${number}","summary":"<one sentence>","comment_url":"<html_url of the review you posted; gh api repos/${owner}/${repo}/pulls/${number}/reviews --jq '.[-1].html_url'>","findings":[{"severity":"high|medium|low","file":"<path>","line":<number or null>,"title":"<short>","suggestion":"<what to do instead>"}]}`,
    `Then print exactly one line: HERDR_DIA_RESULT ${resultFile}`,
  ].filter(Boolean).join('\n');
}

export function implementBrief({ owner, repo, number, url, title, instruction, existing = false }) {
  const link = url || `https://github.com/${owner}/${repo}/pull/${number}`;
  const setup = existing
    ? `Setup: this directory is a fresh git worktree of ${owner}/${repo} created for this task. Run gh pr checkout ${number} so you are on the PR branch (if that branch is checked out in another worktree, fetch it with git fetch origin pull/${number}/head and work on it from here), and make sure it is up to date.`
    : `Setup: this directory is reserved for ${owner}/${repo}. If it is not a git checkout yet, clone the repository here first (gh repo clone ${owner}/${repo} .). Then run gh pr checkout ${number} so you are on the PR branch, and make sure it is up to date.`;
  return [
    `You are working on GitHub pull request ${owner}/${repo}#${number}${title ? ` — "${title}"` : ''} (${link}).`,
    setup,
    'Task:',
    instruction.trim() || '(no instruction given — read the PR and its review comments, then propose what to do before changing anything)',
    "When done: commit in the same style as the branch's existing commits, push to the PR branch, and summarize what changed.",
  ].join('\n');
}

// ---------------------------------------------------------------- git worktrees
// A git worktree we manage ourselves (so it can live as a tab in the shared workspace, which
// Herdr's own worktree.create can't do). Shares the checkout's .git; pushes reach the PR
// branch. Idempotent: a leftover from a retry is reused; an existing branch is checked out
// rather than recreated.
export function addGitWorktree(checkout, wtPath, branch) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  if (fs.existsSync(path.join(wtPath, '.git'))) return;
  let branchExists = false;
  try { execFileSync('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', branch], { stdio: 'pipe' }); branchExists = true; } catch {}
  const args = branchExists
    ? ['-C', checkout, 'worktree', 'add', wtPath, branch]
    : ['-C', checkout, 'worktree', 'add', wtPath, '-b', branch, 'HEAD'];
  execFileSync('git', args, { stdio: 'pipe' });
}
