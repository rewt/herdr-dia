// dia.queue — the review queue: five tiers built from notifications, review requests and your
// own PRs, filtered by repo, decorated with the agents and reviews already in flight.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withEnv } from './helpers.mjs';
import { notification, otherNotification, searchPr, minePr, reviewResult } from './fixtures/github.mjs';

const scenario = {
  notifications: [
    notification({ repo: 'herdr-dia', number: 1, id: 'th-1', reason: 'review_requested', updatedAt: '2026-09-01T12:00:00Z' }),
    notification({ repo: 'other-repo', number: 2, id: 'th-2', reason: 'mention', updatedAt: '2026-09-01T11:00:00Z' }),
    otherNotification({ id: 'th-3' }),
  ],
  requested: [
    searchPr({ repo: 'herdr-dia', number: 1, author: 'alice' }),           // also in the brief
    searchPr({ repo: 'team-repo', number: 30, author: 'bob' }),
    searchPr({ repo: 'team-repo', number: 31, author: 'alice', updatedAt: '2026-09-01T08:00:00Z' }),
  ],
  mine: [
    minePr({ repo: 'herdr-dia', number: 40, reviewDecision: 'APPROVED', updatedAt: '2026-09-01T13:00:00Z' }),
    minePr({ repo: 'herdr-dia', number: 41, isDraft: true }),
  ],
};

test('dia.queue sorts PRs into brief, team, mine and other', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });

    assert.equal(q.type, 'queue');
    assert.deepEqual(q.brief.map((p) => `${p.repo}#${p.number}`), ['herdr-dia#1', 'other-repo#2'], 'newest notification first');
    assert.deepEqual(q.team.map((p) => `${p.repo}#${p.number}`), ['team-repo#30', 'team-repo#31'], 'grouped by repo, newest first');
    assert.deepEqual(q.mine.map((p) => p.number), [40], 'drafts are hidden while Mine shows open PRs');
    assert.deepEqual(q.other.map((o) => o.reason), ['ci_activity']);
    assert.equal(q.brief[0].reason, 'review_requested');
    assert.equal(q.brief[0].threadId, 'th-1', 'the thread id travels so a dispatch can mark it read');
    assert.equal(q.brief[0].url, 'https://github.com/rewt/herdr-dia/pull/1');
  });
});

test('a PR in both the brief and the review requests appears once, with its author', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    const inBrief = q.brief.filter((p) => p.repo === 'herdr-dia' && p.number === 1);
    const inTeam = q.team.filter((p) => p.repo === 'herdr-dia' && p.number === 1);
    assert.equal(inBrief.length, 1);
    assert.equal(inTeam.length, 0, 'the brief wins; team does not repeat it');
    assert.equal(inBrief[0].author, 'alice', 'the author is backfilled from the search');
  });
});

test('prs is every tier flattened, favorites and mine first', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos, favorites: ['bob'] });
    assert.deepEqual(q.prs.map((p) => `${p.repo}#${p.number}`), ['team-repo#30', 'herdr-dia#40', 'herdr-dia#1', 'other-repo#2', 'team-repo#31']);
  });
});

test('favorites are pulled out of brief and team and grouped by author', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos, favorites: ['@Alice'] });
    assert.deepEqual(q.favorites.map((p) => `${p.repo}#${p.number}`), ['herdr-dia#1', 'team-repo#31'], 'sorted by author, then recency');
    assert.ok(q.favorites.every((p) => p.author === 'alice'));
    assert.equal(q.brief.some((p) => p.author === 'alice'), false, 'no leaking back into brief');
    assert.equal(q.team.some((p) => p.author === 'alice'), false, 'no leaking back into team');
    assert.deepEqual(q.team.map((p) => p.number), [30]);
  });
});

test('knownRepos and knownAuthors feed the settings chips', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.deepEqual(q.knownRepos, ['herdr-dia', 'other-repo', 'team-repo']);
    assert.deepEqual(q.knownAuthors, ['alice', 'bob'], 'authors come from brief + team');
  });
});

test('the repo filter scopes every tier and is reported back', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos, repos: ['team-repo'] });
    assert.equal(q.repoFilterActive, true);
    assert.deepEqual(q.brief, []);
    assert.deepEqual(q.mine, []);
    assert.deepEqual(q.team.map((p) => p.number), [30, 31]);
    assert.deepEqual(q.knownRepos, ['herdr-dia', 'other-repo', 'team-repo'], 'the chips still list every repo seen');
  });
});

test('the repo filter also accepts owner/repo', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos, repos: ['rewt/herdr-dia'] });
    assert.deepEqual(q.brief.map((p) => p.number), [1]);
    assert.deepEqual(q.mine.map((p) => p.number), [40]);
    assert.deepEqual(q.team, []);
  });
});

test('onlyUnapproved defaults on and narrows the search itself', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.equal(q.onlyUnapproved, true);
    const search = env.ghCallsMatching(/--review-requested=@me/)[0];
    assert.ok(search.argv.join(' ').includes('--review required'), search.argv.join(' '));
  });
});

test('turning onlyUnapproved off widens the search back out', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos, onlyUnapproved: false });
    assert.equal(q.onlyUnapproved, false);
    const search = env.ghCallsMatching(/--review-requested=@me/)[0];
    assert.equal(search.argv.includes('--review'), false);
  });
});

test('Mine defaults to open PRs and switches to closed on request', async () => {
  await withEnv({ scenario }, async (env) => {
    const open = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.equal(open.mineState, 'open');
    assert.ok(env.ghCallsMatching(/graphql/)[0].argv.join(' ').includes('is:pr is:open author:@me'));

    const closed = await env.host.send('dia.queue', { reposRoot: env.repos, mineState: 'closed' });
    assert.equal(closed.mineState, 'closed');
    assert.ok(env.ghCallsMatching(/graphql/)[1].argv.join(' ').includes('is:pr is:closed author:@me'));
    assert.deepEqual(closed.mine.map((p) => p.number), [40, 41], 'a closed draft is still yours');
  });
});

test('Mine carries the review decision and mergeability the merge button needs', async () => {
  await withEnv({ scenario }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.equal(q.mine[0].reviewDecision, 'APPROVED');
    assert.equal(q.mine[0].mergeable, 'MERGEABLE');
    assert.equal(q.brief[0].reviewDecision, undefined, 'only your own PRs get a decision');
  });
});

test('Mine falls back to the REST search when GraphQL fails', async () => {
  const failing = { ...scenario, fail: { graphql: 'HTTP 403 (blocked by policy)' }, mineRest: [searchPr({ repo: 'herdr-dia', number: 40, author: 'rewt' })] };
  await withEnv({ scenario: failing }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.deepEqual(q.mine.map((p) => p.number), [40], 'Mine is never empty just because enrichment failed');
    assert.equal(q.mine[0].reviewDecision, null, 'no decision without GraphQL');
    assert.ok(env.ghCallsMatching(/--author=@me/).length === 1);
  });
});

test('a notifications outage still leaves the rest of the queue standing', async () => {
  await withEnv({ scenario: { ...scenario, fail: { notifications: 'HTTP 502' } } }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.deepEqual(q.brief, []);
    assert.deepEqual(q.other, []);
    assert.deepEqual(q.team.map((p) => p.number), [1, 30, 31], 'the review requests are all still there');
  });
});

test('a queue PR carries the review already written for it', async () => {
  await withEnv({ scenario }, async (env) => {
    env.writeReviewResult('rewt', 'herdr-dia', 1, reviewResult({ number: 1, summary: 'two problems', findings: [{ severity: 'high', title: 'a' }, { severity: 'low', title: 'b' }] }));
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.equal(q.brief[0].result.summary, 'two problems');
    assert.equal(q.brief[0].result.findings.length, 2);
    assert.ok(q.brief[0].result.writtenAt);
    assert.equal(q.brief[1].result, null);
  });
});

test('a queue PR carries the agent working on it, and knows review from update', async () => {
  await withEnv({ scenario }, async (env) => {
    env.herdr.addAgent({ name: 'rv-1-herdr-dia-ab12', agent: 'claude', agent_status: 'working' });
    env.herdr.addAgent({ name: 'pr-30-team-repo-cd34', agent: 'claude', agent_status: 'blocked' });
    env.herdr.addAgent({ name: 'unrelated-agent', agent: 'claude', agent_status: 'idle' });

    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    const briefPr = q.brief.find((p) => p.number === 1);
    assert.equal(briefPr.agent.name, 'rv-1-herdr-dia-ab12');
    assert.equal(briefPr.agent.mode, 'review');
    assert.equal(briefPr.agent.status, 'working');

    const teamPr = q.team.find((p) => p.number === 30);
    assert.equal(teamPr.agent.mode, 'implement', 'an update outranks a review on the same PR');
    assert.equal(q.team.find((p) => p.number === 31).agent, null);
  });
});

test('the queue creates the repos root and reports it', async () => {
  await withEnv({ scenario }, async (env) => {
    const root = `${env.home}/fresh-root`;
    const q = await env.host.send('dia.queue', { reposRoot: root });
    assert.equal(q.root, root);
    assert.ok(fs.existsSync(root), 'the root is created if it does not exist yet');
  });
});

test('the queue asks gh with the identity it was given, from the repos root', async () => {
  await withEnv({ scenario }, async (env) => {
    await env.host.send('dia.queue', { reposRoot: env.repos, ghConfigDir: '~/.config/gh-work' });
    for (const call of env.ghCalls()) {
      assert.equal(call.ghConfigDir, `${env.home}/.config/gh-work`, `${call.argv.join(' ')} used the wrong identity`);
      assert.equal(call.cwd, env.repos);
      assert.equal(call.quiet, '1', 'the identity wrapper is kept quiet');
    }
  });
});

test('an empty GitHub answers with empty tiers, not an error', async () => {
  await withEnv({ scenario: {} }, async (env) => {
    const q = await env.host.send('dia.queue', { reposRoot: env.repos });
    assert.deepEqual([q.favorites, q.mine, q.brief, q.team, q.other, q.prs], [[], [], [], [], [], []]);
    assert.deepEqual(q.knownRepos, []);
    assert.deepEqual(q.knownAuthors, []);
  });
});
