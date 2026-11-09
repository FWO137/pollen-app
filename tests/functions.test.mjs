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
const failEndpoints = new Set();
const fakeWebpush = {
  setVapidDetails() {},
  async sendNotification(subscription, payload) {
    if (failEndpoints.has(subscription.endpoint)) {
      const err = new Error('push failed');
      err.statusCode = 500;
      throw err;
    }
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
  assert.equal(stored.allergens, null); // omitted field = every pollen

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

test('check-pollen: a further rise or a same-level wiggle the same day does not notify again', async () => {
  // The München subscription above was just notified for grass low → medium.
  // One pollen, one push per day — even if it later climbs another bucket.
  const realFetch = globalThis.fetch;
  const respond = (grass) => async (url) => {
    if (String(url).includes('opendata.dwd.de')) {
      return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [] }) };
    }
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [grass], alder_pollen: [0], birch_pollen: [0],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ measurements: [] }) };
  };

  sentPushes.length = 0;
  globalThis.fetch = respond(48); // still medium
  let res = await checkPollenHandler();
  globalThis.fetch = realFetch;
  assert.equal((await res.json())[0].status, 'no-change');
  assert.equal(sentPushes.length, 0);

  globalThis.fetch = respond(250); // very-high, second increase today
  res = await checkPollenHandler();
  globalThis.fetch = realFetch;
  assert.equal((await res.json())[0].status, 'no-change');
  assert.equal(sentPushes.length, 0);
});

test('check-pollen: a failed delivery does not advance the snapshot, and the retry does not double-send', async () => {
  const subsStore = fakeGetStore('push-subscriptions');
  await subsStore.setJSON('sub-retry', {
    subscription: { endpoint: 'https://push.example/retry', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 47.07, lon: 15.44, country: 'AT', dwd: null, lgl: null },
    locationName: 'Graz',
  });
  await subsStore.setJSON('sub-retry-2', {
    subscription: { endpoint: 'https://push.example/retry-2', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 47.07, lon: 15.44, country: 'AT', dwd: null, lgl: null },
    locationName: 'Graz',
  });

  const realFetch = globalThis.fetch;
  const respond = (grass) => async (url) => {
    if (String(url).includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [grass], alder_pollen: [0], birch_pollen: [0],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [], measurements: [] }) };
  };

  globalThis.fetch = respond(0);
  await checkPollenHandler(); // baseline
  globalThis.fetch = realFetch;

  failEndpoints.add('https://push.example/retry'); // the other Graz subscriber still succeeds
  const grazPushes = () => sentPushes.filter((p) => p.payload.title.includes('Graz'));
  sentPushes.length = 0;
  globalThis.fetch = respond(45);
  let res = await checkPollenHandler();
  globalThis.fetch = realFetch;
  const failed = (await res.json()).find((r) => String(r.sig).startsWith('47.07'));
  assert.equal(failed.status, 'delivery-failed');
  assert.equal(grazPushes().length, 1);

  failEndpoints.clear();
  sentPushes.length = 0;
  globalThis.fetch = respond(45);
  res = await checkPollenHandler();
  globalThis.fetch = realFetch;
  const retried = (await res.json()).find((r) => String(r.sig).startsWith('47.07'));
  assert.equal(retried.status, 'notified');
  assert.equal(grazPushes().length, 1, 'only the subscriber who missed the first attempt');
  assert.equal(grazPushes()[0].subscription.endpoint, 'https://push.example/retry');
});

test('check-pollen: allergen filter drops unrelated rises, and a far ePIN station is not used', async () => {
  const subsStore = fakeGetStore('push-subscriptions');
  await subsStore.setJSON('sub-birch-only', {
    subscription: { endpoint: 'https://push.example/birch-only', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 48.2082, lon: 16.3738, country: 'AT', dwd: null, lgl: null },
    locationName: 'Wien',
    allergens: ['birch'],
  });
  // Ingolstadt used to be pinned to the Munich trap (~70 km). A spike at
  // DEMUNC must not become this city's forecast.
  await subsStore.setJSON('sub-ingolstadt', {
    subscription: { endpoint: 'https://push.example/ingolstadt', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 48.7665, lon: 11.4258, country: 'DE', dwd: 121, lgl: 'DEMUNC' },
    locationName: 'Ingolstadt',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('epin.lgl')) {
      return {
        ok: true,
        json: async () => ({
          measurements: [{ location: 'DEMUNC', polle: 'Poaceae', data: [{ value: 5000, to: 1 }] }],
        }),
      };
    }
    if (u.includes('air-quality-api.open-meteo.com')) {
      const lat = Number(new URL(u).searchParams.get('latitude'));
      const birch = lat > 48.5 ? 0 : 0; // both baseline
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [0], alder_pollen: [0], birch_pollen: [birch],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [] }) };
  };
  await checkPollenHandler();
  globalThis.fetch = realFetch;

  sentPushes.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('epin.lgl')) {
      return {
        ok: true,
        json: async () => ({
          measurements: [{ location: 'DEMUNC', polle: 'Poaceae', data: [{ value: 5000, to: 1 }] }],
        }),
      };
    }
    if (u.includes('air-quality-api.open-meteo.com')) {
      const lat = Number(new URL(u).searchParams.get('latitude'));
      const isVienna = lat < 48.5;
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            // Vienna: grass rises (not in this subscriber's allergens), birch stays none.
            // Ingolstadt: grass stays 0. If DEMUNC were applied it would be very-high.
            grass_pollen: [isVienna ? 45 : 0], alder_pollen: [0], birch_pollen: [0],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [] }) };
  };
  await checkPollenHandler();
  globalThis.fetch = realFetch;
  assert.equal(sentPushes.length, 0);

  const historyRes = await historyHandler(getRequest('http://localhost/x?lat=48.7665&lon=11.4258'));
  const { history } = await historyRes.json();
  assert.equal(history.at(-1).pollens.grass.level, 'none');
  assert.notEqual(history.at(-1).pollens.grass.source, 'lgl');

  sentPushes.length = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('air-quality-api.open-meteo.com')) {
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: [new Date().toISOString()],
            grass_pollen: [45], alder_pollen: [0], birch_pollen: [100],
            mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ last_update: '2026-08-17 11:00', content: [], measurements: [] }) };
  };
  await checkPollenHandler();
  globalThis.fetch = realFetch;
  const viennaPush = sentPushes.find((p) => p.payload.title.includes('Wien'));
  assert.ok(viennaPush, 'birch rise is delivered to the birch-only subscriber');
  assert.match(viennaPush.payload.body, /Birke/);
  assert.doesNotMatch(viennaPush.payload.body, /Gräser/);
  assert.match(viennaPush.payload.body, /Hohe Belastung/); // birch, not the unselected grass
});

test('subscribe: stores a normalized allergen selection', async () => {
  const payload = {
    subscription: { endpoint: 'https://push.example/allergens', keys: { p256dh: 'p', auth: 'a' } },
    location: { lat: 48.14, lon: 11.58, country: 'DE', dwd: 121, lgl: 'DEMUNC' },
    locationName: 'München',
    allergens: ['grass', 'nope', 'birch', 'grass'],
  };
  const res = await subscribeHandler(jsonRequest(payload));
  assert.equal(res.status, 200);
  const store = fakeGetStore('push-subscriptions');
  const { blobs } = await store.list();
  let found = null;
  for (const { key } of blobs) {
    const row = await store.get(key);
    if (row?.subscription?.endpoint === payload.subscription.endpoint) found = row;
  }
  assert.deepEqual(found.allergens, ['birch', 'grass']);

  sentPushes.length = 0;
  const again = await subscribeHandler(jsonRequest({ ...payload, locationName: 'Schwabing', allergens: ['birch'] }));
  assert.equal(again.status, 200);
  assert.equal(sentPushes.length, 0, 'updating an existing subscription does not repeat the confirmation push');
  let updated = null;
  for (const { key } of (await store.list()).blobs) {
    const row = await store.get(key);
    if (row?.subscription?.endpoint === payload.subscription.endpoint) updated = row;
  }
  assert.equal(updated.locationName, 'Schwabing');
  assert.deepEqual(updated.allergens, ['birch']);
  assert.equal(updated.createdAt, found.createdAt);
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
