// The test harness: a throwaway HOME, a fake Herdr socket, a fake `gh` first on the host's
// PATH, and a native-messaging client that talks to a real host process over stdio — the
// same framing the browser uses (4-byte little-endian length + JSON).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeHerdr } from './fake-herdr.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST_ENTRY = path.join(ROOT, 'host', 'bridge.mjs');
export const FAKE_GH = path.join(ROOT, 'test', 'bin', 'gh');

// git, deliberately deaf to the ambient identity: this shell exports GIT_CONFIG_* (and the
// user has a global config), and a test repo must not inherit either.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'herdr-dia tests', GIT_AUTHOR_EMAIL: 'tests@example.invalid',
  GIT_COMMITTER_NAME: 'herdr-dia tests', GIT_COMMITTER_EMAIL: 'tests@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A real git repository with one commit, and an origin that resolveRepoDir can recognize.
export function initRepo(dir, { origin = null, file = 'README.md', content = 'hello\n' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', 'main', '-q', dir]);
  fs.writeFileSync(path.join(dir, file), content);
  git(['add', '.'], { cwd: dir });
  git(['commit', '-q', '-m', 'first'], { cwd: dir });
  if (origin) git(['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

export function tmpDir(prefix = 'herdr-dia-test-') {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and a child process's
  // cwd comes back resolved, which would defeat every path comparison in the suite.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export async function waitFor(predicate, { timeout = 15_000, interval = 25, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- native messaging client
class HostClient {
  constructor(child) {
    this.child = child;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];      // { subscription, event, data } pushed by dia.subscribe
    this.stderr = '';
    this.exited = null;
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
        buffer = buffer.subarray(4 + length);
        this.#onMessage(message);
      }
    });
    child.stderr.on('data', (chunk) => { this.stderr += chunk.toString('utf8'); });
    child.on('exit', (code, signal) => { this.exited = { code, signal }; });
  }

  #onMessage(message) {
    if (message.subscription) { this.events.push(message); return; }
    const entry = this.pending.get(message.id);
    if (!entry) { this.orphan = message; return; }
    if (message.progress !== undefined) { entry.progress.push(message.progress); return; }
    this.pending.delete(message.id);
    if (message.error) entry.reject(Object.assign(new Error(message.error.message || 'error'), { herdr: message.error }));
    else entry.resolve(message.result);
  }

  // Send one framed message. `raw` bypasses framing helpers for the malformed-input tests.
  write(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([head, body]));
  }

  writeRaw(text) {
    const body = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([head, body]));
  }

  // Ask the host for something. Resolves with the result; `progress` collects the progress
  // lines the route emitted along the way.
  send(method, params = {}, { timeout = 30_000 } = {}) {
    const id = `t${++this.seq}`;
    const progress = [];
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout} ms`)); }, timeout);
      this.pending.set(id, {
        progress,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    promise.progress = progress;
    this.write({ id, method, params });
    return promise;
  }

  // The panel closing: ends stdin, which is how the host learns to shut down.
  endStdin() { this.child.stdin.end(); }
}

// Start a real host process with exactly this environment (nothing is inherited), and a
// client already framing messages to it.
export function spawnHost(env) {
  const child = spawn(process.execPath, [HOST_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'], env });
  return new HostClient(child);
}

// ---------------------------------------------------------------- the environment
// home/            a throwaway $HOME (~/.herdr-dia state lands here)
// home/.local/bin/gh   the fake gh — the host puts ~/.local/bin first on its own PATH
// home/repos/      the repos root a launch resolves checkouts under
export async function createEnv({ scenario = {}, herdr: herdrOptions = {}, env: extraEnv = {} } = {}) {
  const home = tmpDir();
  const tmp = path.join(home, 'tmp');
  const repos = path.join(home, 'repos');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(repos, { recursive: true });
  fs.symlinkSync(FAKE_GH, path.join(home, '.local', 'bin', 'gh'));

  const scenarioFile = path.join(home, 'gh-scenario.json');
  const ghLog = path.join(home, 'gh-calls.log');
  writeJson(scenarioFile, scenario);
  fs.writeFileSync(ghLog, ''); // so a test can assert that gh was never called

  const herdr = await startFakeHerdr({ socketPath: path.join(home, 'herdr.sock'), ...herdrOptions });

  const host = spawnHost({
    PATH: `${path.join(home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: tmp,
    HERDR_SOCKET_PATH: herdr.socketPath,
    HERDR_DIA_TEST_GH: scenarioFile,
    HERDR_DIA_TEST_GH_LOG: ghLog,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extraEnv,
  });
  const child = host.child;

  return {
    home, tmp, repos, herdr, host, scenarioFile, ghLog,

    // Rewrite the scenario the fake gh answers from, mid-test.
    setScenario(next) { writeJson(scenarioFile, next); },

    // Every gh invocation the host made: { argv, cwd, ghConfigDir }.
    ghCalls() {
      return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    ghCallsMatching(pattern) {
      return this.ghCalls().filter((c) => pattern.test(c.argv.join(' ')));
    },

    // ~/.herdr-dia state, as the host wrote it.
    statePath(...parts) { return path.join(home, '.herdr-dia', ...parts); },
    sessionsRegistry() { return readJson(path.join(home, '.herdr-dia', 'sessions.json'), {}); },
    worktreeRegistry() { return readJson(path.join(home, '.herdr-dia', 'worktrees.json'), {}); },
    writeReviewResult(owner, repo, number, result) {
      const file = path.join(home, '.herdr-dia', 'reviews', owner, repo, `${number}.json`);
      writeJson(file, result);
      return file;
    },

    async cleanup() {
      try { child.kill('SIGKILL'); } catch {}
      await herdr.close();
      try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    },
  };
}

// Run `body` against a fresh environment and always tear it down.
export async function withEnv(options, body) {
  const fn = typeof options === 'function' ? options : body;
  const opts = typeof options === 'function' ? {} : options;
  const env = await createEnv(opts);
  try {
    return await fn(env);
  } finally {
    await env.cleanup();
  }
}

// A bare client for the socket itself (used to prove the fake speaks the real protocol).
export function herdrCall(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let carry = '';
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'x', method, params })}\n`));
    socket.on('data', (data) => {
      carry += data.toString('utf8');
      const newline = carry.indexOf('\n');
      if (newline < 0) return;
      const reply = JSON.parse(carry.slice(0, newline));
      socket.destroy();
      if (reply.error) reject(Object.assign(new Error(reply.error.message), { herdr: reply.error }));
      else resolve(reply.result);
    });
    socket.on('error', reject);
  });
}
