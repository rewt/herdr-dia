// Screenshot harness: runs the real panel.js against an invented company.
// Nothing here touches a real host, a real GitHub account, or a real Herdr socket.
//
// Orchard grows fruit and runs software to do it: field gateways that report soil
// moisture, a scheduler that decides what gets picked, a dashboard its growers use.
// Every org, repo, author and pull request below is fictional.
//
// ?view=<favorites|mine|brief|team|other|review|settings> opens one view on load, so
// scripts/screenshots.mjs can capture each of them without a human clicking.

const ORG = 'orchard';
const now = Date.now();

const REVIEW_TEXT = `Reviewed orchard/orchard-sensors#482 — "Retry a stale moisture reading before skipping the zone"

The retry is right for a single zone, but a gateway payload carrying more than one
zone falls through to the block-wide branch — that re-runs irrigation for every zone
in the block, not the one that reported stale. It would have fired on Tuesday's push.

Blocker: the fan-out at ingest/schedule.py:212. The other four can land after it.

I can post this as a comment, or apply the two HIGH fixes on the branch and push.`;

const FINDINGS = [
  { severity: 'HIGH', file: 'ingest/schedule.py', line: 212, title: 'multi-zone payload waters the whole block', suggestion: 'Guard the loop; schedule only the zones named in the payload.' },
  { severity: 'HIGH', file: 'ingest/auth.py', line: 238, title: 'gateway token compared with == (timing-unsafe)', suggestion: 'Use a constant-time comparison.' },
  { severity: 'MED', file: 'ingest/main.py', line: 96, title: 'retry window lowered 60s → 5s without a note' },
  { severity: 'MED', file: 'tests/test_schedule.py', line: 41, title: 'test asserts 200 but never checks which zones ran' },
  { severity: 'LOW', file: 'ingest/main.py', line: 14, title: 'comment still refers to the old gateway id' },
];

const pr = (repo, number, author, title, extra = {}) =>
  ({ owner: ORG, repo, number, author, title, url: `https://github.com/${ORG}/${repo}/pull/${number}`, ...extra });

const QUEUE = {
  favorites: [
    pr('orchard-web', 1184, 'd-quince', 'Keep the unsaved harvest plan when the tab reloads'),
    pr('orchard-api', 771, 'd-quince', 'Rate-limit ingest per block, not per gateway token'),
    pr('orchard-sensors', 482, 'm-bramley', 'Retry a stale moisture reading before skipping the zone'),
    pr('orchard-harvest', 219, 'm-bramley', 'Split the staging scheduler off the shared queue'),
  ],
  mine: [
    pr('orchard-web', 1190, 'octocat', 'Trace ids survive the grower sign-in redirect', { reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }),
    pr('orchard-harvest', 224, 'octocat', 'Pin the picker roster job to one worker', { reviewDecision: 'CHANGES_REQUESTED', mergeable: 'MERGEABLE' }),
    pr('orchard-api', 780, 'octocat', 'Drop the unused webhook retry queue', { reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING' }),
  ],
  brief: [
    pr('orchard-sensors', 482, 'm-bramley', 'Retry a stale moisture reading before skipping the zone', { reason: 'review_requested' }),
    pr('orchard-web', 1187, 's-pippin', 'Move the yield formatter into the shared package', { reason: 'mention' }),
    pr('orchard-api', 776, 'j-medlar', 'Return 409 instead of 500 on duplicate crate ids', { reason: 'review_requested' }),
    pr('orchard-mobile', 342, 'k-russet', 'Retry the token refresh once before signing the picker out', { reason: 'assign' }),
  ],
  team: [
    pr('orchard-api', 771, 'd-quince', 'Rate-limit ingest per block, not per gateway token'),
    pr('orchard-api', 776, 'j-medlar', 'Return 409 instead of 500 on duplicate crate ids'),
    pr('orchard-api', 779, 's-pippin', 'Backfill the crate index in batches'),
    pr('orchard-harvest', 219, 'm-bramley', 'Split the staging scheduler off the shared queue'),
    pr('orchard-harvest', 221, 'j-medlar', 'Rotate the gateway enrolment keys'),
    pr('orchard-sensors', 482, 'm-bramley', 'Retry a stale moisture reading before skipping the zone'),
    pr('orchard-sensors', 486, 'k-russet', 'Serve the last good reading when a gateway drops out'),
    pr('orchard-web', 1184, 'd-quince', 'Keep the unsaved harvest plan when the tab reloads'),
    pr('orchard-web', 1187, 's-pippin', 'Move the yield formatter into the shared package'),
    pr('orchard-web', 1191, 'k-russet', 'Lazy-load the block map'),
  ],
  other: [
    { repo: `${ORG}/orchard-harvest`, reason: 'approval_requested', title: 'Deploy staging → production', url: `https://github.com/${ORG}/orchard-harvest/actions` },
    { repo: `${ORG}/orchard-web`, reason: 'ci_activity', title: 'Nightly e2e run failed on main', url: `https://github.com/${ORG}/orchard-web/actions` },
  ],
  knownRepos: ['orchard-api', 'orchard-harvest', 'orchard-mobile', 'orchard-sensors', 'orchard-web'],
  knownAuthors: ['d-quince', 'j-medlar', 'k-russet', 'm-bramley', 's-pippin'],
};

const SESSIONS = [
  {
    agentName: 'rv-482-orchard-sensors-a1c3', owner: ORG, repo: 'orchard-sensors', number: 482,
    mode: 'review', title: 'Retry a stale moisture reading before skipping the zone',
    createdAt: new Date(now - 6 * 60000).toISOString(),
    url: `https://github.com/${ORG}/orchard-sensors/pull/482`, paneId: 'p31',
  },
  {
    agentName: 'pr-1184-orchard-web-7f20', owner: ORG, repo: 'orchard-web', number: 1184,
    mode: 'implement', title: 'Keep the unsaved harvest plan when the tab reloads',
    createdAt: new Date(now - 2 * 60000).toISOString(),
    url: `https://github.com/${ORG}/orchard-web/pull/1184`, paneId: 'p32',
  },
];

const AGENTS = [
  { name: 'rv-482-orchard-sensors-a1c3', kind: 'claude', pane_id: 'p31', agent_status: 'blocked', tab_id: 't7' },
  { name: 'pr-1184-orchard-web-7f20', kind: 'claude', pane_id: 'p32', agent_status: 'working', tab_id: 't8' },
];

const ROUTES = {
  'dia.hello': () => ({ socket: '/Users/demo/.config/herdr/herdr.sock', home: '/Users/demo', protocol: 20 }),
  'dia.config': () => ({
    identities: [{ dir: '/Users/demo/.config/gh', name: 'gh', account: 'octocat', isDefault: true }],
    claudeConfigs: [{ dir: '/Users/demo/.claude', name: '.claude', isDefault: true }],
    agents: [{ kind: 'claude', version: '2.4.1' }, { kind: 'codex' }, { kind: 'gemini' }, { kind: 'qwen' }],
  }),
  'dia.queue': () => QUEUE,
  'dia.sessions': () => ({ sessions: SESSIONS }),
  'agent.list': () => ({ agents: AGENTS }),
  'dia.subscribe': () => ({ ok: true }),
  'dia.worktrees': () => ({ worktrees: [
    { id: 'w1', owner: ORG, repo: 'orchard-web', number: 1184, branch: 'herdr-dia/pr-1184', clean: true, open: true },
  ] }),
  'dia.review_text': () => ({ text: REVIEW_TEXT, result: { pr: `${ORG}/orchard-sensors#482`, recommendation: 'request changes', findings: FINDINGS } }),
  'agent.focus': () => ({ ok: true }),
};

// ---- the chrome shim the panel expects -------------------------------------
const listeners = { message: [], disconnect: [] };
const fakePort = {
  onMessage: { addListener: (fn) => listeners.message.push(fn) },
  onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
  postMessage(msg) {
    const route = ROUTES[msg.method];
    setTimeout(() => {
      const reply = route
        ? { id: msg.id, result: route(msg.params || {}) }
        : { id: msg.id, error: { code: 'unknown_method', message: `no fixture for ${msg.method}` } };
      for (const fn of listeners.message) fn(reply);
    }, 40);
  },
};

const STORE = {
  reposRoot: '~/development/orchard',
  ghConfigDir: '', claudeConfigDir: '', kind: 'claude',
  planMode: true, focus: false,
  repos: [], favorites: ['d-quince', 'm-bramley'], onlyUnapproved: true, mineState: 'open',
};

const TAB = {
  id: 1,
  url: `https://github.com/${ORG}/orchard-sensors/pull/482`,
  title: 'Retry a stale moisture reading before skipping the zone by m-bramley · Pull Request #482 · orchard/orchard-sensors · GitHub',
};

window.chrome = {
  runtime: { connectNative: () => fakePort, lastError: null },
  tabs: {
    create: ({ url }) => console.log('would open', url),
    query: async () => [TAB],
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  windows: { onFocusChanged: { addListener: () => {} } },
  storage: { local: { get: async (keys) => Object.fromEntries(keys.map((k) => [k, STORE[k]])), set: (o) => Object.assign(STORE, o) } },
};

// ---- ?view=… : open one view, then publish the height a capture needs -------
const PARAMS = new URLSearchParams(location.search);
const VIEW = PARAMS.get('view');
// A capture asks for zoom so the image is retina-sharp while the panel still lays out at the
// width of a real side panel (Chrome clamps how small a headless window may be).
if (PARAMS.get('zoom')) document.documentElement.style.zoom = PARAMS.get('zoom');

const clickText = (selector, text) => {
  const el = [...document.querySelectorAll(selector)].find((n) => n.textContent.trim().startsWith(text));
  if (el) el.click();
  return Boolean(el);
};

const tier = (label) => () => clickText('.tab', label);

const OPEN = {
  favorites: tier('Favorites'),
  mine: tier('Mine'),
  brief: tier('Brief'),
  team: tier('Team'),
  other: tier('Other'),
  settings: () => Boolean(document.getElementById('gear')?.click() ?? true),
  // The board expands a review the moment it is ready, so the button is already there.
  review: () => clickText('#agents button', 'Read review'),
};

if (VIEW) {
  const open = OPEN[VIEW];
  if (!open) console.warn(`no such view: ${VIEW}`);
  // Wait for the panel's first render, then act. scripts/screenshots.mjs gives the page
  // plenty of (virtual) time before it captures.
  let tries = 0;
  const attempt = setInterval(() => {
    if ((open && open()) || ++tries > 40) clearInterval(attempt);
  }, 100);
}
