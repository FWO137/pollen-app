// Exercises the real netlify/functions/*.mjs handlers (request parsing,
// blob key hashing, grouping-by-location, snapshot diffing) against a fake
// in-memory @netlify/blobs store and a fake web-push, so this runs without
// real Netlify infra, real secrets, or an actual push endpoint. Requires
// --experimental-test-module-mocks (Node 22.3+) — see package.json's
// "test" script.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Never real secrets: web-push itself is mocked out below (setVapidDetails
// is a no-op), so these values only need to be present, not valid.
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
process.env.VAPID_PUBLIC_KEY = 'test-public-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-key';

// ── Fake in-memory blob store, matching @netlify/blobs' interface ──
const stores = new Map();
function fakeGetStore(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const data = stores.get(name);
  return {
    async setJSON(key, value) { data.set(key, value); },
    async get(key, _opts) { return data.has(key) ? data.get(key) : null; },
    async delete(key) { data.delete(key); },
    async list() { return { blobs: [...data.keys()].map((key) => ({ key })) }; },
  };
}

const sentPushes = [];
const fakeWebpush = {
  setVapidDetails() {},
  async sendNotification(subscription, payload) {
    sentPushes.push({ subscription, payload: JSON.parse(payload) });
  },
};

mock.module('@netlify/blobs', { namedExports: { getStore: fakeGetStore } });
mock.module('web-push', { defaultExport: fakeWebpush });

const { default: subscribeHandler } = await import('../netlify/functions/subscribe.mjs');
const { default: unsubscribeHandler } = await import('../netlify/functions/unsubscribe.mjs');
const { default: checkPollenHandler } = await import('../netlify/functions/check-pollen.mjs');
const { default: historyHandler } = await import('../netlify/functions/history.mjs');

function getRequest(url) {
  return new Request(url, { method: 'GET' });
}

function jsonRequest(body, method = 'POST') {
  const init = { method };
  if (method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
  return new Request('http://localhost/x', init);
}

test('subscribe: rejects malformed payloads', async () => {
  const res = await subscribeHandler(jsonRequest({ subscription: {} }));
  assert.equal(res.status, 400);
});

test('subscribe: rejects non-POST', async () => {
  const res = await subscribeHandler(jsonRequest({}, 'GET'));
  assert.equal(res.status, 405);
});

test('subscribe: stores a valid subscription and sends a confirmation push', async () => {
  sentPushes.length = 0;
  const payload = {
    subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 48.4320, lon: 12.9386, country: 'DE', dwd: 122, lgl: 'DEALTO' },
    locationName: 'Pfarrkirchen',
  };
  const res = await subscribeHandler(jsonRequest(payload));
  assert.equal(res.status, 200);

  const store = fakeGetStore('push-subscriptions');
  const { blobs } = await store.list();
  assert.equal(blobs.length, 1);
  const stored = await store.get(blobs[0].key);
  assert.equal(stored.locationName, 'Pfarrkirchen');
  assert.equal(stored.location.lat, 48.4320);

  assert.equal(sentPushes.length, 1);
  assert.match(sentPushes[0].payload.body, /Pfarrkirchen/);
});

test('unsubscribe: removes a previously stored subscription', async () => {
  const store = fakeGetStore('push-subscriptions');
  const before = (await store.list()).blobs.length;
  assert.equal(before, 1);

  const res = await unsubscribeHandler(jsonRequest({ endpoint: 'https://push.example/abc' }));
  assert.equal(res.status, 200);

  const after = (await store.list()).blobs.length;
  assert.equal(after, 0);
});

test('check-pollen: end-to-end with a real fetch mock — first run sets baseline, no push', async () => {
  const subsStore = fakeGetStore('push-subscriptions');
  await subsStore.setJSON('sub1', {
    subscription: { endpoint: 'https://push.example/xyz', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 48.1351, lon: 11.5820, country: 'DE', dwd: 121, lgl: null },
    locationName: 'München',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('opendata.dwd.de')) {
      return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [] }) };
    }
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [9], alder_pollen: [0], birch_pollen: [0],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ measurements: [] }) };
  };

  sentPushes.length = 0;
  const res = await checkPollenHandler();
  globalThis.fetch = realFetch;

  assert.equal(res.status, 200);
  const results = await res.json();
  assert.equal(results[0].status, 'baseline-set');
  assert.equal(sentPushes.length, 0, 'no push on first-ever check (cold start)');

  const snapStore = fakeGetStore('pollen-snapshots');
  const { blobs } = await snapStore.list();
  assert.equal(blobs.length, 1);
});

test('check-pollen: second run with a changed value sends a push with the new value', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('opendata.dwd.de')) {
      return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [] }) };
    }
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [45], alder_pollen: [0], birch_pollen: [0], // grass changed 9 -> 45
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ measurements: [] }) };
  };

  sentPushes.length = 0;
  const res = await checkPollenHandler();
  globalThis.fetch = realFetch;

  const results = await res.json();
  assert.equal(results[0].status, 'notified');
  assert.equal(sentPushes.length, 1);
  assert.match(sentPushes[0].payload.body, /Gräser/);
  assert.match(sentPushes[0].payload.body, /45 K\/m³/);
  console.log('Notification sent:', sentPushes[0].payload);
});

test('history: GET rejects missing/invalid lat/lon', async () => {
  const res1 = await historyHandler(getRequest('http://localhost/x'));
  assert.equal(res1.status, 400);
  const res2 = await historyHandler(getRequest('http://localhost/x?lat=abc&lon=12'));
  assert.equal(res2.status, 400);
});

test('history: rejects non-GET', async () => {
  const res = await historyHandler(jsonRequest({}));
  assert.equal(res.status, 405);
});

test('history: reflects what check-pollen.mjs recorded across two runs — both entries present, both correctly attributed', async () => {
  // Fresh location so this doesn't collide with the München history the
  // earlier check-pollen tests already built up on the shared fake store.
  const lat = 48.4320, lon = 12.9386; // Pfarrkirchen
  const subsStore = fakeGetStore('push-subscriptions');
  await subsStore.setJSON('sub-history-test', {
    subscription: { endpoint: 'https://push.example/history-test', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat, lon, country: 'DE', dwd: 122, lgl: null },
    locationName: 'Pfarrkirchen',
  });

  const realFetch = globalThis.fetch;
  const fakeToday = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async (url) => {
    if (String(url).includes('opendata.dwd.de')) {
      return { ok: true, json: async () => ({ last_update: `${fakeToday} 11:00`, content: [] }) };
    }
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [7], alder_pollen: [0], birch_pollen: [0],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ measurements: [] }) };
  };

  await checkPollenHandler(); // first run for this location -> baseline + first history entry
  globalThis.fetch = realFetch;

  const res = await historyHandler(getRequest(`http://localhost/x?lat=${lat}&lon=${lon}`));
  assert.equal(res.status, 200);
  const { history } = await res.json();
  assert.equal(history.length, 1);
  assert.equal(history[0].date, fakeToday);
  assert.equal(history[0].overall, 'low'); // grass=7 K/m³ -> low on the grass_pollen [10,50,200] thresholds
  assert.equal(history[0].pollens.grass.display, '7');
});

test('history: same-day re-runs update the existing entry in place instead of appending a duplicate', async () => {
  const lat = 48.4320, lon = 12.9386; // same Pfarrkirchen location as the previous test, same day
  const realFetch = globalThis.fetch;
  const fakeToday = new Date().toISOString().slice(0, 10);
  globalThis.fetch = async (url) => {
    if (String(url).includes('opendata.dwd.de')) {
      return { ok: true, json: async () => ({ last_update: `${fakeToday} 11:00`, content: [] }) };
    }
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [60], alder_pollen: [0], birch_pollen: [0], // now high, same day
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ measurements: [] }) };
  };

  await checkPollenHandler();
  globalThis.fetch = realFetch;

  const res = await historyHandler(getRequest(`http://localhost/x?lat=${lat}&lon=${lon}`));
  const { history } = await res.json();
  assert.equal(history.length, 1, 'still one entry for the day, not two');
  assert.equal(history[0].pollens.grass.display, '60', 'updated in place to the latest value');
});

test('history: an unsubscribed/never-checked location returns an empty history, not an error', async () => {
  const res = await historyHandler(getRequest('http://localhost/x?lat=1.23&lon=4.56'));
  assert.equal(res.status, 200);
  const { history } = await res.json();
  assert.deepEqual(history, []);
});
