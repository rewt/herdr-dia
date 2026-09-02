// Installs the herdr-dia native-messaging host and prepares the extension for loading.
//
//   node scripts/install.mjs
//
// It registers the host for every Chromium browser found (Dia, Chrome, Arc, Brave, Edge,
// Chromium) so the extension can reach the Herdr socket, and pins a key in the extension
// manifest so its id is stable. The only step it can't do for you is the one-click "Load
// unpacked" in the browser's extensions page — it prints exactly where to point it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_NAME = 'com.herdr.dia_bridge';
const home = os.homedir();

const [major] = process.versions.node.split('.').map(Number);
if (major < 20) {
  console.error(`herdr-dia needs Node 20+, found ${process.versions.node}.`);
  process.exit(1);
}

// Stable extension id: pin a public key in the manifest; Chromium derives the id from it.
const manifestPath = path.join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!manifest.key) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
const der = Buffer.from(manifest.key, 'base64');
const extensionId = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

// A tiny wrapper with an absolute node path — browsers launch hosts with a minimal PATH.
const runner = path.join(root, 'host', process.platform === 'win32' ? 'run.cmd' : 'run.sh');
if (process.platform === 'win32') {
  fs.writeFileSync(runner, `@echo off\r\n"${process.execPath}" "${path.join(root, 'host', 'bridge.mjs')}" %*\r\n`);
} else {
  fs.writeFileSync(runner, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, 'host', 'bridge.mjs')}"\n`);
  fs.chmodSync(runner, 0o755);
}

const hostManifest = {
  name: HOST_NAME,
  description: 'herdr-dia: pipe between the Dia extension and the Herdr socket',
  path: runner,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

// Where each Chromium browser looks for user-scoped native-messaging host manifests.
function hostDirs() {
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return {
      Dia: path.join(support, 'Dia', 'NativeMessagingHosts'),
      'Arc': path.join(support, 'Arc', 'User Data', 'NativeMessagingHosts'),
      Chrome: path.join(support, 'Google', 'Chrome', 'NativeMessagingHosts'),
      Brave: path.join(support, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      Edge: path.join(support, 'Microsoft Edge', 'NativeMessagingHosts'),
      Chromium: path.join(support, 'Chromium', 'NativeMessagingHosts'),
    };
  }
  if (process.platform === 'linux') {
    const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return {
      Chrome: path.join(cfg, 'google-chrome', 'NativeMessagingHosts'),
      Chromium: path.join(cfg, 'chromium', 'NativeMessagingHosts'),
      Brave: path.join(cfg, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
    };
  }
  return {};
}

const dirs = hostDirs();
if (!Object.keys(dirs).length) {
  console.error(`Unsupported platform "${process.platform}". Register ${runner} as native-messaging host "${HOST_NAME}" by hand (on Windows this is a registry key pointing at a manifest).`);
  process.exit(1);
}

// Register for whichever browsers are installed, and Dia always (its profile dir may not
// exist until first run, but the manifest location is fixed).
const installed = [];
for (const [browser, dir] of Object.entries(dirs)) {
  const profile = path.dirname(dir); // the browser's data dir, e.g. .../Dia or .../Google/Chrome
  if (browser !== 'Dia' && !fs.existsSync(profile)) continue; // Dia's dir may not exist until first run
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), `${JSON.stringify(hostManifest, null, 2)}\n`);
  installed.push(browser);
}

// A quick, non-fatal check that Herdr is reachable.
const socket = process.env.HERDR_SOCKET_PATH || path.join(home, '.config', 'herdr', 'herdr.sock');
const herdrUp = await new Promise((resolve) => {
  const s = net.connect(socket);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 1500);
});

console.log(`
herdr-dia installed.

  extension id   : ${extensionId}
  host runner    : ${runner}
  registered for : ${installed.join(', ') || '(none found)'}
  herdr socket   : ${socket} ${herdrUp ? '(reachable)' : '(NOT reachable — start Herdr with `herdr`)'}
  host log       : ${path.join(os.tmpdir(), 'herdr-dia-host.log')}

Last step (the only manual one): open your browser's extensions page, turn on
developer mode, click "Load unpacked", and choose:

  ${path.join(root, 'extension')}

Then click the herdr-dia toolbar icon to open the panel.
`);
