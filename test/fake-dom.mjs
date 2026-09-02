// Just enough DOM and just enough `chrome` to boot extension/panel.js in Node: element nodes
// with the handful of properties the panel actually sets, a native-messaging port that answers
// from a handler map, and storage/tabs stubs. Not a browser — a stand-in that lets the panel's
// real rendering code run and be read back.

class FakeText {
  constructor(text) { this.nodeType = 3; this._text = String(text); }
  get textContent() { return this._text; }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this._text = '';
    this._class = '';
    this.attributes = new Map();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
  }

  get className() { return this._class; }
  set className(value) { this._class = String(value); }

  get classList() {
    const classes = () => this._class.split(/\s+/).filter(Boolean);
    return {
      add: (...names) => { this._class = [...new Set([...classes(), ...names])].join(' '); },
      remove: (...names) => { this._class = classes().filter((c) => !names.includes(c)).join(' '); },
      contains: (name) => classes().includes(name),
    };
  }

  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(value) { this.children = []; this._text = String(value); }

  append(...nodes) {
    for (const node of nodes) this.children.push(typeof node === 'string' ? new FakeText(node) : node);
  }
  appendChild(node) { this.append(node); return node; }

  get childElementCount() { return this.children.filter((c) => c.nodeType === 1).length; }

  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.nodeType === 1 && c.contains(node));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  // Fire a listener the way a click would, with an event object that carries the two methods
  // the panel calls on it.
  dispatch(type) {
    const event = { type, stopPropagation() {}, preventDefault() {} };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
}

// Every element in the tree, depth first.
export function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) if (child.nodeType === 1) walk(child, out);
  return out;
}

export const find = (root, predicate) => walk(root).find(predicate) || null;
export const findAll = (root, predicate) => walk(root).filter(predicate);
export const byText = (root, text) => find(root, (el) => el.textContent.trim() === text);
export const byClass = (root, name) => findAll(root, (el) => el.classList.contains(name));

// Install the fakes as globals and boot-proof the module scope panel.js runs in. Returns the
// handles a test needs: the element registry, the requests the panel made, and the tabs it
// asked the browser to open.
export function installPanelDom({ tab = null, handlers = {}, storage = {} } = {}) {
  const elements = new Map();
  const requests = [];
  const opened = [];
  const listeners = { message: [], disconnect: [] };
  let answered = 0;

  const el = (id) => {
    if (!elements.has(id)) {
      const node = new FakeElement('div');
      node.id = id;
      elements.set(id, node);
    }
    return elements.get(id);
  };

  globalThis.document = {
    getElementById: el,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(text),
    activeElement: null,
  };

  const port = {
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage(message) {
      requests.push(message);
      // Answer out of band, as the host would.
      queueMicrotask(async () => {
        const handler = handlers[message.method];
        let reply;
        try {
          if (!handler) throw Object.assign(new Error(`no fake for ${message.method}`), { code: 'unknown_method' });
          reply = { id: message.id, result: await handler(message.params || {}) };
        } catch (error) {
          reply = { id: message.id, error: { code: error.code || 'host_error', message: error.message } };
        }
        answered++;
        for (const fn of listeners.message) fn(reply);
      });
    },
  };

  globalThis.chrome = {
    runtime: { connectNative: () => port, lastError: null },
    storage: { local: { get: async () => ({ ...storage }), set: async () => {} } },
    tabs: {
      query: async () => (tab ? [tab] : []),
      create: (options) => opened.push(options),
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    windows: { onFocusChanged: { addListener() {} } },
  };

  // The panel sets three refresh intervals at the end of the file; leave them unscheduled so
  // importing it does not keep the test process alive.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;

  return {
    el,
    requests,
    opened,
    port,
    requestsFor: (method) => requests.filter((r) => r.method === method),
    // Push a subscription event at the panel, as the host would.
    emit(message) { for (const fn of listeners.message) fn(message); },
    // Wait until every request the panel has made has been answered and the renders that
    // follow have run.
    async settle({ rounds = 60 } = {}) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        if (answered === requests.length && i > 3) return;
      }
    },
    restore() { globalThis.setInterval = realSetInterval; },
  };
}
