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
