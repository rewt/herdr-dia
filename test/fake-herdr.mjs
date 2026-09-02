// A fake Herdr server, speaking the real wire protocol (protocol 20): newline-delimited
// JSON over a unix socket, one request per connection (the server closes after replying),
// with events.subscribe the only long-lived stream.
//
// It holds workspaces/tabs/panes/agents in memory so a test can script exactly the state a
// route should meet — an agent that is blocked on the trust dialog, a pane showing the
// plan-mode checkpoint, a start that answers agent_pane_busy twice — and can then read back
// every call the host made.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Script a Claude Code select dialog onto an agent: the highlight moves with the arrow keys
// exactly as the host expects ("❯ N. option"), and Enter hands the chosen option to onSelect.
export function scriptDialog(agent, { header = "Here is Claude's plan:\nWould you like to proceed?", options, selected = 0, onSelect = () => {} }) {
  let index = selected;
  const render = () => [header, ...options.map((o, i) => `${i === index ? '❯' : ' '} ${i + 1}. ${o}`)].join('\n');
  agent.screen = render();
  agent.onKeys = (keys) => {
    for (const key of keys) {
      if (key === 'down') index = Math.min(index + 1, options.length - 1);
      else if (key === 'up') index = Math.max(index - 1, 0);
      else if (key === 'enter') return onSelect(options[index], index, agent);
    }
    agent.screen = render();
  };
  return agent;
}

export function herdrError(code, message) {
  const e = new Error(message || code);
  e.herdr = { code, message: message || code };
  return e;
}

export async function startFakeHerdr(options = {}) {
  const socketPath = options.socketPath || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-')), 'herdr.sock');
  const state = {
    workspaces: new Map(),   // id -> { workspace_id, label, cwd, env }
    tabs: new Map(),         // id -> { tab_id, workspace_id, label, cwd, env }
    panes: new Map(),        // id -> { pane_id, tab_id, workspace_id, cwd }
    agents: new Map(),       // name -> agent record (+ screen, prompts, keys)
    manifests: options.manifests || [
      { agent: 'claude', active_version: '1.2.3' },
      { agent: 'codex', active_version: '0.9.0' },
      { agent: 'gemini', active_version: null },
    ],
    // What agent.start hands back as the agent's initial status. Tests flip this to
    // 'blocked' to exercise the trust dialog.
    startStatus: options.startStatus || 'idle',
    startScreen: options.startScreen || '',
  };

  let ids = 0;
  const nextId = (prefix) => `${prefix}${++ids}`;
  const calls = [];
  const streams = new Set();
  const failures = new Map(); // method -> [{ code, message, times }]

  const server = net.createServer((socket) => {
    let carry = '';
    socket.on('data', async (chunk) => {
      carry += chunk.toString('utf8');
      let newline;
      while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { continue; }
        calls.push({ method: request.method, params: request.params || {} });
        if (request.method === 'events.subscribe') {
          streams.add(socket);
          socket.on('close', () => streams.delete(socket));
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscribed', subscriptions: request.params?.subscriptions || [] } })}\n`);
          continue; // the stream stays open
        }
        let reply;
        try {
          reply = { id: request.id, result: await dispatch(request.method, request.params || {}) };
        } catch (error) {
          reply = { id: request.id, error: error.herdr || { code: 'server_error', message: error.message } };
        }
        socket.write(`${JSON.stringify(reply)}\n`);
        socket.end(); // one request per connection, exactly like Herdr
      }
    });
    socket.on('error', () => {});
  });

  async function dispatch(method, params) {
    const queued = failures.get(method);
    if (queued && queued.length) {
      const f = queued[0];
      if (--f.times <= 0) queued.shift();
      throw herdrError(f.code, f.message);
    }
    const override = api.handlers[method];
    if (override) return override(params, api);
    const handler = defaults[method];
    if (!handler) throw herdrError('unknown_method', `no such method: ${method}`);
    return handler(params);
  }

  const openTab = ({ workspace_id, cwd, env, label }) => {
    const tab = { tab_id: nextId('t'), workspace_id, cwd, env: env || {}, label };
    state.tabs.set(tab.tab_id, tab);
    const pane = { pane_id: nextId('p'), tab_id: tab.tab_id, workspace_id, cwd };
    state.panes.set(pane.pane_id, pane);
    return { tab, pane };
  };

  const defaults = {
    ping: () => ({ type: 'pong', protocol: 20 }),

    'session.snapshot': () => ({
      snapshot: {
        workspaces: [...state.workspaces.values()].map((w) => ({
          ...w,
          tabs: [...state.tabs.values()].filter((t) => t.workspace_id === w.workspace_id),
        })),
      },
    }),

    'workspace.create': ({ cwd, label, env, focus }) => {
      const ws = { workspace_id: nextId('w'), label, cwd, env: env || {}, focus: Boolean(focus) };
      state.workspaces.set(ws.workspace_id, ws);
      // Herdr always leaves an empty root tab behind, labelled with a bare number.
      const { tab, pane } = openTab({ workspace_id: ws.workspace_id, cwd, env, label: String(state.tabs.size + 1) });
      return { workspace: ws, root_tab: tab, root_pane: pane };
    },

    'tab.create': ({ workspace_id, cwd, env, label }) => {
      if (!state.workspaces.has(workspace_id)) throw herdrError('workspace_not_found', workspace_id);
      const { tab, pane } = openTab({ workspace_id, cwd, env, label });
      return { tab, root_pane: pane };
    },

    'tab.list': ({ workspace_id }) => ({
      tabs: [...state.tabs.values()].filter((t) => !workspace_id || t.workspace_id === workspace_id),
    }),

    'tab.close': ({ tab_id }) => {
      if (!state.tabs.has(tab_id)) throw herdrError('tab_not_found', tab_id);
      state.tabs.delete(tab_id);
      for (const [id, pane] of state.panes) if (pane.tab_id === tab_id) state.panes.delete(id);
      // Closing a tab kills whatever agent was running in it.
      for (const [name, agent] of state.agents) if (agent.tab_id === tab_id) state.agents.delete(name);
      return { type: 'tab_closed', tab_id };
    },

    'pane.list': ({ workspace_id }) => ({
      panes: [...state.panes.values()].filter((p) => !workspace_id || p.workspace_id === workspace_id),
    }),

    'pane.close': ({ pane_id }) => {
      state.panes.delete(pane_id);
      for (const [name, agent] of state.agents) if (agent.pane_id === pane_id) state.agents.delete(name);
      return { type: 'pane_closed', pane_id };
    },

    'agent.start': ({ name, kind, pane_id, args }) => {
      const pane = state.panes.get(pane_id);
      if (!pane) throw herdrError('pane_not_found', String(pane_id));
      const agent = {
        name, agent: kind, agent_status: state.startStatus, pane_id,
        tab_id: pane.tab_id, workspace_id: pane.workspace_id, cwd: pane.cwd,
        args: args || [], screen: state.startScreen, prompts: [], keys: [],
      };
      state.agents.set(name, agent);
      // A test can script what this agent does next — the trust dialog, the plan checkpoint.
      options.onAgentStart?.(agent, api);
      return { type: 'agent_started', name, agent: kind };
    },

    'agent.list': () => ({ agents: [...state.agents.values()].map(publicAgent) }),

    'agent.prompt': ({ target, text }) => {
      const agent = state.agents.get(target);
      if (!agent) throw herdrError('agent_not_found', target);
      if (agent.agent_status === 'blocked') throw herdrError('agent_blocked', `${target} is blocked`);
      agent.prompts.push(text);
      agent.onPrompt?.(text, agent);
      return { type: 'prompted', name: target };
    },

    'agent.read': ({ target, source, lines }) => {
      const agent = state.agents.get(target);
      if (!agent) throw herdrError('agent_not_found', target);
      if (source === 'recent_unwrapped' && agent.notIdle) throw herdrError('agent_not_idle', `${target} is not idle`);
      const text = source === 'visible' ? String(agent.screen || '') : String(agent.scrollback ?? agent.screen ?? '');
      return { read: { text, source, lines, truncated: Boolean(agent.truncated) } };
    },

    'agent.send_keys': ({ target, keys }) => {
      const agent = state.agents.get(target);
      if (!agent) throw herdrError('agent_not_found', target);
      agent.keys.push(...keys);
      agent.onKeys?.(keys, agent);
      return { type: 'keys_sent', name: target, keys };
    },

    'agent.focus': ({ target }) => ({ type: 'focused', target }),

    'server.agent_manifests': () => ({ manifests: state.manifests }),
  };

  const publicAgent = (a) => ({
    name: a.name, agent: a.agent, agent_status: a.agent_status, pane_id: a.pane_id,
    tab_id: a.tab_id, workspace_id: a.workspace_id, cwd: a.cwd,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const api = {
    socketPath,
    state,
    calls,
    handlers: {},              // method -> fn(params, api): overrides a default for one test

    // What the host asked for, in order.
    callsTo(method) { return calls.filter((c) => c.method === method); },
    lastCall(method) { return [...calls].reverse().find((c) => c.method === method) || null; },

    // Answer `method` with an error the next `times` calls (then behave normally).
    failNext(method, code, message, times = 1) {
      if (!failures.has(method)) failures.set(method, []);
      failures.get(method).push({ code, message, times });
    },

    // Put an agent on the board without a launch (for sessions self-heal, review_text, …).
    addAgent(agent) {
      const record = {
        agent: 'claude', agent_status: 'idle', pane_id: nextId('p'), tab_id: nextId('t'),
        workspace_id: 'w1', cwd: process.cwd(), args: [], screen: '', prompts: [], keys: [],
        ...agent,
      };
      state.agents.set(record.name, record);
      return record;
    },
    agent(name) { return state.agents.get(name) || null; },
    setAgent(name, patch) { Object.assign(state.agents.get(name) || {}, patch); },
    agentNames() { return [...state.agents.keys()]; },
    tabLabels() { return [...state.tabs.values()].map((t) => t.label); },
    workspaceLabels() { return [...state.workspaces.values()].map((w) => w.label); },

    // Push an event to every open events.subscribe stream.
    push(event, data) {
      for (const socket of streams) socket.write(`${JSON.stringify({ event, data })}\n`);
    },
    streamCount() { return streams.size; },
    streamSockets() { return [...streams]; },

    async close() {
      for (const socket of streams) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      try { fs.rmSync(socketPath, { force: true }); } catch {}
    },
  };
  return api;
}
