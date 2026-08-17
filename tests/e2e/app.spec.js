// @ts-check
import { test, expect } from '@playwright/test';

const OM_FIXTURE = {
  hourly: {
    time: ['2026-08-09T00:00'],
    alder_pollen: [50], birch_pollen: [5], grass_pollen: [120],
    mugwort_pollen: [1], ragweed_pollen: [1], olive_pollen: [0],
  },
};

async function stubMunichGeolocation(page) {
  await page.addInitScript(() => {
    navigator.geolocation.getCurrentPosition = (success) => {
      setTimeout(() => success({ coords: { latitude: 48.1351, longitude: 11.5820, accuracy: 10 } }), 10);
    };
  });
}

// Lets a test fast-forward Date.now() (window.__advanceClock(ms)) and force
// document.visibilityState (window.__setVisible(bool)) without waiting real
// wall-clock minutes or needing a real backgrounded tab.
async function installControllableClock(page) {
  await page.addInitScript(() => {
    const RealDate = Date;
    let offset = 0;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(RealDate.now() + offset);
        return new RealDate(...args);
      }
      static now() { return RealDate.now() + offset; }
    }
    window.Date = FakeDate;
    window.__advanceClock = (ms) => { offset += ms; };

    let visible = true;
    Object.defineProperty(document, 'visibilityState', { get: () => (visible ? 'visible' : 'hidden') });
    window.__setVisible = (v) => {
      visible = v;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

test.describe('pollen-logic.js load failure', () => {
  // Regression test: before this guard existed, a failed pollen-logic.js
  // load left the app hanging forever on "Standort wird ermittelt …" with
  // no error shown at all (the window.PollenLogic destructuring threw
  // uncaught and silently halted the rest of the script).
  test('shows a real error message instead of hanging silently', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('**/pollen-logic.js', (route) => route.abort());
    await page.goto('/');
    await page.waitForTimeout(500);

    await expect(page.locator('.state-view')).toBeVisible();
    await expect(page.locator('.state-view')).toContainText('App konnte nicht geladen werden');
    await expect(page.locator('#locationName')).toHaveText('Standort ermitteln …'); // never got past the guard
    expect(pageErrors).toEqual([]);
  });
});

test.describe('refresh race condition', () => {
  // Regression test: loadData() had no request sequencing. A manual
  // refresh fired while a background refresh (from cache hydration) was
  // still in flight could have its result overwritten by the background
  // one if that response happened to land later — whichever network
  // response arrived last won, regardless of which request was actually
  // more recent/intended.
  test('the later-started request wins, even if its response arrives first', async ({ page }) => {
    const SLOW_OM = { hourly: { time: ['2026-08-09T00:00'], alder_pollen: [0], birch_pollen: [0], grass_pollen: [9999], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };
    const FAST_OM = { hourly: { time: ['2026-08-09T00:00'], alder_pollen: [0], birch_pollen: [0], grass_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };

    await stubMunichGeolocation(page);
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    let callCount = 0;
    await page.route('**/air-quality-api.open-meteo.com/**', async (route) => {
      callCount++;
      if (callCount === 1) {
        // Request #1 (background refresh from cache hydration): started
        // first, but deliberately answers last.
        await new Promise((r) => setTimeout(r, 1000));
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SLOW_OM) });
      }
      // Request #2 (manual geoBtn click, fired while #1 is in flight):
      // started second, but answers first.
      await new Promise((r) => setTimeout(r, 100));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAST_OM) });
    });

    // Seed the cache via an init script — it must be in place *before* the
    // app's own script runs, or the plain page.goto() below triggers its
    // own uncached fetch first and throws off which request is #1 vs #2.
    const pollenKeys = ['hazel', 'alder', 'ash', 'birch', 'plane', 'olive', 'grass', 'rye', 'mugwort', 'ragweed'];
    await page.addInitScript((keys) => {
      localStorage.setItem('pollenCacheV1', JSON.stringify({
        locationKey: 'munich',
        customCoords: null,
        data: [0, 1, 2].map((i) => ({
          date: `2026-08-0${9 + i}`,
          pollens: Object.fromEntries(keys.map((k) => [k, null])),
        })),
        dataTimestamp: null,
        locationName: 'München',
        savedAt: Date.now(),
      }));
    }, pollenKeys);

    // This single load hydrates instantly from cache and kicks off
    // requestGeo({background:true}) — that's request #1.
    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();

    // Fire the manual refresh (request #2) while #1 is still in flight.
    await page.waitForTimeout(150);
    await page.click('#geoBtn');

    // Let both requests fully resolve.
    await page.waitForTimeout(1400);

    // If the race guard is broken, request #1's stale "very-high grass"
    // result (which answers last) would win and show a Gräser row.
    await expect(page.locator('.p-row', { hasText: 'Gräser' })).toHaveCount(0);
  });
});

test.describe('staleness refresh on return-to-tab', () => {
  // Regression test: previously nothing re-fetched on its own — a tab left
  // open past DWD's once-a-day / LGL's hourly refresh cadence (or simply
  // backgrounded and returned to later) kept showing the same data
  // indefinitely, with no trigger to reload it.
  test('re-fetches once the tab becomes visible again after 30+ minutes, but not sooner', async ({ page }) => {
    await stubMunichGeolocation(page);
    await installControllableClock(page);
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    let omCalls = 0;
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => {
      omCalls++;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OM_FIXTURE) });
    });

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    expect(omCalls).toBe(1);

    // Tab briefly hidden and visible again well within the staleness
    // window — must NOT trigger a second fetch.
    await page.evaluate(() => window.__setVisible(false));
    await page.evaluate(() => window.__advanceClock(2 * 60 * 1000)); // +2 min
    await page.evaluate(() => window.__setVisible(true));
    await page.waitForTimeout(300);
    expect(omCalls).toBe(1);

    // Now push well past the 30-minute staleness threshold and return to
    // the tab again — this time it must refetch.
    await page.evaluate(() => window.__setVisible(false));
    await page.evaluate(() => window.__advanceClock(31 * 60 * 1000)); // +31 min more (33 min total)
    await page.evaluate(() => window.__setVisible(true));
    await expect.poll(() => omCalls, { timeout: 5000 }).toBe(2);
  });
});

// Mocks navigator.standalone (iOS's "installed to home screen" signal),
// Notification.requestPermission, and PushManager.subscribe/getSubscription
// — a real push subscription needs an actual browser push service, which
// isn't available in an automated test, so this verifies everything up to
// that boundary: UI gating, and exactly what gets POSTed to the server.
async function installPushMocks(page, { standalone = true } = {}) {
  await page.addInitScript((standaloneVal) => {
    if (standaloneVal) {
      Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
    }
    window.Notification = window.Notification || function () {};
    window.Notification.requestPermission = async () => 'granted';

    let subscribed = null;
    const fakeSub = {
      endpoint: 'https://push.example/fake-endpoint',
      toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } }; },
      unsubscribe: async () => { subscribed = null; return true; },
    };
    if (window.PushManager) {
      window.PushManager.prototype.subscribe = async function () { subscribed = fakeSub; return fakeSub; };
      window.PushManager.prototype.getSubscription = async function () { return subscribed; };
    }
  }, standalone);
}

test.describe('push notification subscribe UI', () => {
  test('a regular (non-standalone) tab shows a hint instead of a working button', async ({ page }) => {
    await stubMunichGeolocation(page);
    await installPushMocks(page, { standalone: false });
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OM_FIXTURE) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();

    await expect(page.locator('#notifySection')).toContainText('Zum Home-Bildschirm hinzufügen');
    await expect(page.locator('#notifySection button')).toHaveCount(0);
  });

  test('installed (standalone) app: subscribing and unsubscribing POST the right payloads', async ({ page }) => {
    await stubMunichGeolocation(page);
    await installPushMocks(page, { standalone: true });
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OM_FIXTURE) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    let subscribeBody = null;
    await page.route('**/.netlify/functions/subscribe', async (route) => {
      subscribeBody = JSON.parse(route.request().postData());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    let unsubscribeBody = null;
    await page.route('**/.netlify/functions/unsubscribe', async (route) => {
      unsubscribeBody = JSON.parse(route.request().postData());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();

    const btn = page.locator('#notifySection button');
    await expect(btn).toHaveText('Benachrichtigungen aktivieren');

    await btn.click();
    await expect(btn).toHaveText('Benachrichtigungen deaktivieren');
    expect(subscribeBody.subscription.endpoint).toBe('https://push.example/fake-endpoint');
    expect(subscribeBody.location).toMatchObject({ country: 'DE', dwd: 121, lgl: 'DEMUNC' }); // München, from stubMunichGeolocation
    expect(subscribeBody.locationName).toBe('München');

    await btn.click();
    await expect(btn).toHaveText('Benachrichtigungen aktivieren');
    expect(unsubscribeBody.endpoint).toBe('https://push.example/fake-endpoint');
  });
});
