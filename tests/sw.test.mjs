// Loads the real sw.js in a minimal fake ServiceWorkerGlobalScope and
// exercises its push/notificationclick handlers — Playwright (used for the
// browser-integration tests in tests/e2e/) has no API to dispatch a
// synthetic 'push' event into a real service worker registration, so this
// verifies that logic directly instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SW_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js');

function loadSw() {
  const listeners = {};
  const shownNotifications = [];
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      registration: {
        showNotification: async (title, opts) => { shownNotifications.push({ title, opts }); },
      },
      clients: { matchAll: async () => [], openWindow: async (url) => ({ opened: url }) },
      location: { origin: 'https://pollen-check.netlify.app' },
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => ({ addAll: async () => {}, put: async () => {}, match: async () => undefined }),
      keys: async () => [],
      match: async () => undefined,
    },
    console,
    URL,
    Response,
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), sandbox);
  return { listeners, shownNotifications };
}

async function firePush(listeners, data) {
  let waited = null;
  listeners.push({ data: { json: () => data }, waitUntil: (p) => { waited = p; } });
  await waited;
}

test('sw.js push handler: shows the server-sent title/body with a collapsing tag', async () => {
  const { listeners, shownNotifications } = loadSw();
  await firePush(listeners, {
    title: 'Pollenwerte aktualisiert – Pfarrkirchen',
    body: 'Geringe Belastung — Gräser: 9 K/m³',
  });

  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].title, 'Pollenwerte aktualisiert – Pfarrkirchen');
  assert.match(shownNotifications[0].opts.body, /9 K\/m³/);
  // Same tag across pushes -> a newer update replaces an unread older one instead of stacking.
  assert.equal(shownNotifications[0].opts.tag, 'pollen-update');
});

test('sw.js push handler: a malformed (non-JSON) payload falls back to default text instead of throwing', async () => {
  const { listeners, shownNotifications } = loadSw();
  let waited = null;
  listeners.push({
    data: { json: () => { throw new Error('not json'); } },
    waitUntil: (p) => { waited = p; },
  });
  await waited;

  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].title, 'Pollenflug');
});

test('sw.js push handler: no data at all still shows a default notification', async () => {
  const { listeners, shownNotifications } = loadSw();
  let waited = null;
  listeners.push({ data: null, waitUntil: (p) => { waited = p; } });
  await waited;

  assert.equal(shownNotifications.length, 1);
  assert.equal(shownNotifications[0].title, 'Pollenflug');
});
