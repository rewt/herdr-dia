// The host's pure functions: naming, path resolution, the result parser, the briefs, and the
// one git leaf (addGitWorktree) — exercised directly, no socket involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expandHome, resolveRepoDir, resultPath, agentSlug, agentBase, agentName, AGENT_NAME_RE,
  readResult, extractResult, planFileFromScreen, PLAN_DIALOG, PERMISSION_PROMPT,
  planReviewBrief, reviewBrief, implementBrief, addGitWorktree,
} from '../host/lib.mjs';
import { tmpDir, initRepo, git, writeJson } from './helpers.mjs';

test('expandHome expands a leading tilde and leaves everything else alone', () => {
  assert.equal(expandHome('~/x/y'), path.join(os.homedir(), 'x/y'));
  assert.equal(expandHome('/abs/path'), '/abs/path');
  assert.equal(expandHome('relative/path'), 'relative/path');
});

test('agentSlug normalizes separators and keeps the whole repository name', () => {
  assert.equal(agentSlug('herdr-dia'), 'herdr-dia');
  assert.equal(agentSlug('example-repository-name'), 'example-repository-name');
  assert.equal(agentSlug('weird.repo_name'), 'weird-repo-name');
  assert.equal(agentSlug('_leading-and-trailing_'), 'leading-and-trailing');
  assert.equal(agentSlug(undefined), '');
});

test('a long repository name is cut from the front, because the tail is what differs', () => {
  const alpha = agentBase('review', 'long-repository-name-alpha', 12);
  const omega = agentBase('review', 'long-repository-name-omega', 12);
  assert.ok(alpha.length <= 26 && omega.length <= 26, 'must fit under Herdr’s agent-name cap');
  assert.notEqual(alpha, omega, 'two repos sharing a long prefix must not collapse into one name');
  assert.ok(alpha.endsWith('alpha'), `kept the wrong end: ${alpha}`);
  assert.ok(!/^-/.test(alpha.slice('rv-12-'.length)), 'no leading dash where the cut landed');
});

test('agentBase puts the number first so #16 and #167 never collide', () => {
  assert.equal(agentBase('review', 'herdr-dia', 16), 'rv-16-herdr-dia');
  assert.notEqual(agentBase('review', 'herdr-dia', 16), agentBase('review', 'herdr-dia', 167));
  assert.equal(agentBase('implement', 'herdr-dia', 7), 'pr-7-herdr-dia');
});

test('agentBase stays inside Herdr’s name budget for a very long repo', () => {
  const base = agentBase('review', 'a-really-extremely-long-repository-name', 12345);
  assert.equal(base.length, 26);
  assert.ok(base.startsWith('rv-12345-'), base);
});

test('agentName adds a random suffix, is unique, and matches the host’s own pattern', () => {
  const a = agentName('review', 'herdr-dia', 3);
  const b = agentName('review', 'herdr-dia', 3);
  assert.notEqual(a, b);
  assert.ok(a.length <= 32, `${a} is ${a.length} chars`);
  const m = AGENT_NAME_RE.exec(a);
  assert.ok(m, `${a} should match the dia agent pattern`);
  assert.equal(m[1], 'rv');
  assert.equal(m[2], '3');
  assert.equal(m[3], 'herdr-dia');
  assert.equal(AGENT_NAME_RE.test('some-other-agent'), false);
});

test('resultPath keeps review results in home state, never in a checkout', () => {
  const file = resultPath('/some/repos/root', 'rewt', 'herdr-dia', 7);
  assert.equal(file, path.join(os.homedir(), '.herdr-dia', 'reviews', 'rewt', 'herdr-dia', '7.json'));
  assert.ok(!file.startsWith('/some/repos/root'));
});

test('readResult returns the parsed file with its path and mtime, or null', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'result.json');
  writeJson(file, { pr: 'rewt/herdr-dia#7', summary: 'looks fine', findings: [] });
  const result = readResult(file);
  assert.equal(result.summary, 'looks fine');
  assert.equal(result.file, file);
  assert.ok(Date.parse(result.writtenAt) > 0);
  assert.equal(readResult(path.join(dir, 'missing.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), 'not json');
  assert.equal(readResult(path.join(dir, 'bad.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- resolveRepoDir
test('resolveRepoDir finds <root>/<repo> when its origin matches', () => {
  const root = tmpDir();
  initRepo(path.join(root, 'herdr-dia'), { origin: 'git@github.com:rewt/herdr-dia.git' });
  const found = resolveRepoDir(root, 'rewt', 'herdr-dia');
  assert.deepEqual(found, { dir: path.join(root, 'herdr-dia'), existing: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveRepoDir finds <root>/<owner>/<repo> and <root>/*/<repo>', () => {
  const root = tmpDir();
  initRepo(path.join(root, 'rewt', 'herdr-dia'), { origin: 'https://github.com/rewt/herdr-dia' });
  initRepo(path.join(root, 'work', 'other-repo'), { origin: 'git@github.com:acme/other-repo.git' });
  assert.deepEqual(resolveRepoDir(root, 'rewt', 'herdr-dia'), { dir: path.join(root, 'rewt', 'herdr-dia'), existing: true });
  assert.deepEqual(resolveRepoDir(root, 'acme', 'other-repo'), { dir: path.join(root, 'work', 'other-repo'), existing: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveRepoDir ignores a same-named checkout of a different owner', () => {
  const root = tmpDir();
  initRepo(path.join(root, 'herdr-dia'), { origin: 'git@github.com:someone-else/herdr-dia.git' });
  const found = resolveRepoDir(root, 'rewt', 'herdr-dia');
  assert.equal(found.existing, false, 'a different owner is not this repo');
  assert.equal(found.dir, path.join(root, 'herdr-dia'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveRepoDir falls back to <root>/<repo> for a fresh clone', () => {
  const root = tmpDir();
  assert.deepEqual(resolveRepoDir(root, 'rewt', 'nothing-here'), { dir: path.join(root, 'nothing-here'), existing: false });
  assert.deepEqual(resolveRepoDir('/does/not/exist', 'rewt', 'x'), { dir: '/does/not/exist/x', existing: false });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- extractResult
const RESULT = '{"pr":"rewt/herdr-dia#7","summary":"ok","recommendation":"comment","findings":[]}';

test('extractResult parses a clean single-line marker', () => {
  const parsed = extractResult(`blah blah\nHERDR_DIA_RESULT ${RESULT}\ntrailing`);
  assert.equal(parsed.pr, 'rewt/herdr-dia#7');
  assert.equal(parsed.recommendation, 'comment');
});

test('extractResult survives the TUI wrapping and indenting the line', () => {
  const wrapped = 'HERDR_DIA_RESULT {"pr":"rewt/herdr-dia#7",\n     "summary":"ok",\n     "findings":[{"severity":"high",\n     "file":"a.js","line":3,"title":"t","suggestion":"s"}]}';
  const parsed = extractResult(wrapped);
  assert.equal(parsed.pr, 'rewt/herdr-dia#7');
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].line, 3);
});

test('extractResult walks braces inside strings without stopping early', () => {
  const text = 'HERDR_DIA_RESULT {"pr":"a/b#1","summary":"use ${x} and }{ braces","findings":[]} trailing text';
  const parsed = extractResult(text);
  assert.equal(parsed.summary, 'use ${x} and }{ braces');
  assert.deepEqual(parsed.findings, []);
});

test('extractResult keeps escaped quotes intact', () => {
  const parsed = extractResult('HERDR_DIA_RESULT {"pr":"a/b#1","summary":"he said \\"hi\\" }","findings":[]}');
  assert.equal(parsed.summary, 'he said "hi" }');
});

test('extractResult uses the last marker when the brief echoed an earlier one', () => {
  const text = `HERDR_DIA_RESULT {"pr":"a/b#1","summary":"the template"}\n…\nHERDR_DIA_RESULT ${RESULT}`;
  assert.equal(extractResult(text).summary, 'ok');
});

test('extractResult returns null when there is no marker or no parsable object', () => {
  assert.equal(extractResult('nothing here'), null);
  assert.equal(extractResult('HERDR_DIA_RESULT no brace follows'), null);
  assert.equal(extractResult('HERDR_DIA_RESULT {not: json}'), null);
});

// ---------------------------------------------------------------- screen reading
test('planFileFromScreen picks the plan path out of the dialog footer', () => {
  const screen = ' Here is Claude\'s plan:\n ctrl+g to edit in Nvim · ~/.claude-personal/plans/review-pr-7.md\n';
  assert.equal(planFileFromScreen(screen), path.join(os.homedir(), '.claude-personal/plans/review-pr-7.md'));
  assert.equal(planFileFromScreen('/tmp/x/plans/abc.md'), '/tmp/x/plans/abc.md');
  assert.equal(planFileFromScreen('no plan on this screen'), null);
});

test('the plan dialog and permission prompts are recognized', () => {
  assert.ok(PLAN_DIALOG.test("Here is Claude's plan:"));
  assert.ok(PLAN_DIALOG.test('Ready to code?'));
  assert.ok(PLAN_DIALOG.test('Would you like to proceed?'));
  assert.equal(PLAN_DIALOG.test('❯ 1. Yes, and use auto mode'), false);
  assert.ok(PERMISSION_PROMPT.test('  Do you want to create review.md?'));
  assert.ok(PERMISSION_PROMPT.test('Do you want to run this command?'));
  assert.equal(PERMISSION_PROMPT.test('Do you want to dance?'), false);
});

// ---------------------------------------------------------------- briefs
const PR = { owner: 'rewt', repo: 'herdr-dia', number: 7, url: 'https://github.com/rewt/herdr-dia/pull/7', title: 'Add tests' };

test('the plan-mode review brief is read-only and asks for the result line', () => {
  const brief = planReviewBrief({ ...PR, instruction: '' });
  assert.match(brief, /You are in plan mode: read and analyze only/);
  assert.match(brief, /Do not post, edit, clone, or write anything/);
  assert.match(brief, /gh pr diff 7 --repo rewt\/herdr-dia/);
  assert.match(brief, /HERDR_DIA_RESULT \{"pr":"rewt\/herdr-dia#7"/);
  assert.match(brief, /Then stop and wait/);
  assert.ok(!brief.includes('Focus:'), 'no focus line without an instruction');
});

test('a review instruction becomes the brief’s focus line', () => {
  const brief = planReviewBrief({ ...PR, instruction: '  check the error handling  ' });
  assert.match(brief, /^Focus: check the error handling$/m);
});

test('the non-plan review brief posts a comment and writes the result file', () => {
  const brief = reviewBrief({ ...PR, instruction: '', resultFile: '/home/u/.herdr-dia/reviews/rewt/herdr-dia/7.json' });
  assert.match(brief, /gh pr review 7 --repo rewt\/herdr-dia --comment --body-file review\.md/);
  assert.match(brief, /Agent review \(herdr-dia\)/);
  assert.match(brief, /HERDR_DIA_RESULT \/home\/u\/\.herdr-dia\/reviews\/rewt\/herdr-dia\/7\.json/);
});

test('the implement brief knows whether it is in a prepared worktree', () => {
  const inWorktree = implementBrief({ ...PR, instruction: 'bump the version', existing: true });
  assert.match(inWorktree, /this directory is a fresh git worktree/);
  assert.match(inWorktree, /gh pr checkout 7/);
  assert.match(inWorktree, /bump the version/);

  const fresh = implementBrief({ ...PR, instruction: '', existing: false });
  assert.match(fresh, /clone the repository here first/);
  assert.match(fresh, /no instruction given/);
});

test('a brief without a url links to the PR page anyway', () => {
  const brief = planReviewBrief({ owner: 'a', repo: 'b', number: 9, url: null, title: '', instruction: '' });
  assert.match(brief, /https:\/\/github\.com\/a\/b\/pull\/9/);
});

// ---------------------------------------------------------------- addGitWorktree
test('addGitWorktree creates the branch and shares the checkout’s .git', () => {
  const root = tmpDir();
  const checkout = initRepo(path.join(root, 'repo'), { origin: 'git@github.com:rewt/repo.git' });
  const wt = path.join(root, 'worktrees', 'repo', 'pr-7');

  addGitWorktree(checkout, wt, 'herdr-dia/pr-7');
  assert.ok(fs.existsSync(path.join(wt, '.git')), 'the worktree exists');
  assert.equal(git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']), 'herdr-dia/pr-7');
  assert.equal(git(['-C', wt, 'rev-parse', 'HEAD']), git(['-C', checkout, 'rev-parse', 'HEAD']));

  fs.rmSync(root, { recursive: true, force: true });
});

test('addGitWorktree is idempotent, and reuses an existing branch', () => {
  const root = tmpDir();
  const checkout = initRepo(path.join(root, 'repo'));
  const wt = path.join(root, 'wt', 'pr-8');

  addGitWorktree(checkout, wt, 'herdr-dia/pr-8');
  fs.writeFileSync(path.join(wt, 'work.txt'), 'in progress\n');
  addGitWorktree(checkout, wt, 'herdr-dia/pr-8'); // a retry must not blow the work away
  assert.equal(fs.readFileSync(path.join(wt, 'work.txt'), 'utf8'), 'in progress\n');

  // The branch already exists (left behind by a removed worktree): check it out, don't recreate.
  fs.rmSync(path.join(wt, 'work.txt'));
  git(['-C', checkout, 'worktree', 'remove', wt]);
  assert.ok(git(['-C', checkout, 'branch', '--list', 'herdr-dia/pr-8']), 'branch survives removal');
  addGitWorktree(checkout, wt, 'herdr-dia/pr-8');
  assert.equal(git(['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']), 'herdr-dia/pr-8');

  fs.rmSync(root, { recursive: true, force: true });
});
