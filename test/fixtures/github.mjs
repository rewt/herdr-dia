// Builders for the GitHub payloads the fake `gh` hands back, in the shapes the real API uses.

export function notification({ owner = 'rewt', repo = 'herdr-dia', number = 1, id = String(number), reason = 'review_requested', title = `PR ${number}`, updatedAt = '2026-09-01T10:00:00Z' } = {}) {
  return {
    id,
    reason,
    updated_at: updatedAt,
    subject: { type: 'PullRequest', title, url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}` },
    repository: { full_name: `${owner}/${repo}`, html_url: `https://github.com/${owner}/${repo}` },
  };
}

export function otherNotification({ id = 'n-other', reason = 'ci_activity', type = 'CheckSuite', title = 'workflow run failed', repo = 'rewt/herdr-dia', updatedAt = '2026-09-01T09:00:00Z' } = {}) {
  return {
    id,
    reason,
    updated_at: updatedAt,
    subject: { type, title, url: null },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
  };
}

// `gh search prs --json number,title,repository,url,updatedAt,author`
export function searchPr({ owner = 'rewt', repo = 'herdr-dia', number = 1, title = `PR ${number}`, author = 'someone', updatedAt = '2026-09-01T10:00:00Z' } = {}) {
  return {
    number, title, updatedAt,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repository: { nameWithOwner: `${owner}/${repo}` },
    author: { login: author },
  };
}

// A node from the `mine` GraphQL search.
export function minePr({ owner = 'rewt', repo = 'herdr-dia', number = 1, title = `PR ${number}`, author = 'rewt', updatedAt = '2026-09-01T10:00:00Z', isDraft = false, reviewDecision = null, mergeable = 'MERGEABLE' } = {}) {
  return {
    number, title, updatedAt, isDraft, reviewDecision, mergeable,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    author: { login: author },
    repository: { nameWithOwner: `${owner}/${repo}` },
  };
}

// What a reviewer agent writes to ~/.herdr-dia/reviews/<owner>/<repo>/<n>.json
export function reviewResult({ owner = 'rewt', repo = 'herdr-dia', number = 1, summary = 'looks reasonable', findings = [] } = {}) {
  return { pr: `${owner}/${repo}#${number}`, summary, recommendation: 'comment', findings };
}
