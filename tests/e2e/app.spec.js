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

test.describe('7-day forecast tabs', () => {
  test('renders one tab per forecast day and "Heute" stays reachable after scrolling to a later day', async ({ page }) => {
    // Regression test: the day-tabs strip used to be `justify-content:
    // flex-end`, which packs overflow toward the *start* of the container.
    // A plain LTR container can't scroll to negative scrollLeft, so once
    // there were more tabs than fit on screen, "Heute" (the first/leftmost
    // tab) became permanently unreachable — clicking it timed out because
    // its on-screen position was clipped away by the container's own
    // overflow, and the click landed on the page behind it instead.
    await stubMunichGeolocation(page);
    const om7 = { hourly: { time: Array.from({ length: 7 }, (_, i) => `2026-08-${17 + i}T00:00`), grass_pollen: Array(7).fill(9), alder_pollen: Array(7).fill(0), birch_pollen: Array(7).fill(0), mugwort_pollen: Array(7).fill(0), ragweed_pollen: Array(7).fill(0), olive_pollen: Array(7).fill(0) } };
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om7) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await expect(page.locator('.day-tab')).toHaveCount(7);
    await expect(page.locator('.day-tab').first()).toHaveText(/Heute/);

    // Jump to the last tab (forces the strip to scroll, since 7 tabs don't fit on a phone width).
    await page.locator('.day-tab').last().click();
    await expect(page.locator('.day-tab').last()).toHaveAttribute('aria-selected', 'true');

    // "Heute" must still be clickable after that, not stuck off-screen.
    await page.locator('.day-tab').first().click({ timeout: 5000 });
    await expect(page.locator('.day-tab').first()).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('season-aware "Kein Flug"', () => {
  test('splits pollens with no data into "in season" vs "outside its season" instead of lumping them together', async ({ page }) => {
    await stubMunichGeolocation(page);
    // Fixed to a date in August: mugwort (Jul–Sep) is in season but 0 here;
    // alder (Jan–Apr) is fully out of season.
    await page.addInitScript(() => {
      const RealDate = Date;
      class FixedDate extends RealDate {
        constructor(...args) { if (args.length === 0) return new RealDate(2026, 7, 17, 8, 0, 0); return new RealDate(...args); }
        static now() { return new RealDate(2026, 7, 17, 8, 0, 0).getTime(); }
      }
      window.Date = FixedDate;
    });
    const om = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [9], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();

    const groups = await page.locator('.no-pollen').allTextContents();
    const inSeason = groups.find((g) => g.includes('Kein Flug'));
    const outOfSeason = groups.find((g) => g.includes('Außerhalb der Saison'));
    expect(inSeason).toMatch(/Beifuß/); // mugwort: Jul–Sep, currently 0
    expect(outOfSeason).toMatch(/Erle/); // alder: Jan–Apr, out of season in August
  });
});

test.describe('7-day trend view', () => {
  const om = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [9], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };

  test('renders one dot per history day, colored by that day\'s overall level', async ({ page }) => {
    await stubMunichGeolocation(page);
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    const history = { history: ['none', 'low', 'medium', 'high', 'very-high'].map((overall, i) => ({ date: `2026-08-1${3 + i}`, overall, pollens: {} })) };
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await expect(page.locator('.trend-dot')).toHaveCount(5);
    await expect(page.locator('.trend-dot').nth(3)).toHaveClass(/l-high/);
  });

  test('hides entirely when there is no history yet (not subscribed / too new), instead of showing an empty section', async ({ page }) => {
    await stubMunichGeolocation(page);
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await expect(page.locator('.trend-wrap')).toHaveCount(0);
  });
});

test.describe('per-pollen trend selection', () => {
  test('tapping a pollen row shows that pollen\'s own history instead of the overall level, and "Alle" resets it', async ({ page }) => {
    await stubMunichGeolocation(page);
    // Today: grass is medium. History: grass swings none -> low -> high across
    // 3 days while the *overall* level (driven by a different dominant pollen
    // each day) stays constant at 'medium' — if the trend dots didn't switch
    // to grass-specific levels after the tap, this would still show 3
    // identical medium dots instead of none/low/high.
    const om = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [45], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    const history = {
      history: [
        { date: '2026-08-15', overall: 'medium', pollens: { grass: { level: 'none', display: '0', unit: 'K/m³', pct: 0 } } },
        { date: '2026-08-16', overall: 'medium', pollens: { grass: { level: 'low', display: '5', unit: 'K/m³', pct: 20 } } },
        { date: '2026-08-17', overall: 'medium', pollens: { grass: { level: 'high', display: '80', unit: 'K/m³', pct: 90 } } },
      ],
    };
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await expect(page.locator('.trend-label')).toHaveText('Verlauf');

    const grassRow = page.locator('.p-row[data-pollen="grass"]');
    await expect(grassRow).toHaveAttribute('aria-pressed', 'false');
    await grassRow.click();

    await expect(grassRow).toHaveAttribute('aria-pressed', 'true');
    await expect(grassRow).toHaveClass(/selected/);
    await expect(page.locator('.trend-label')).toHaveText('Verlauf: Gräser');
    const dots = page.locator('.trend-dot');
    await expect(dots).toHaveCount(3);
    await expect(dots.nth(0)).toHaveClass(/l-none/);
    await expect(dots.nth(1)).toHaveClass(/l-low/);
    await expect(dots.nth(2)).toHaveClass(/l-high/);

    // "Alle" goes back to the overall trend.
    await page.locator('.trend-clear').click();
    await expect(page.locator('.trend-label')).toHaveText('Verlauf');
    await expect(grassRow).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.trend-dot').nth(0)).toHaveClass(/l-medium/);

    // Clicking the same row again toggles it off directly (no "Alle" needed).
    await grassRow.click();
    await expect(grassRow).toHaveAttribute('aria-pressed', 'true');
    await grassRow.click();
    await expect(grassRow).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.trend-label')).toHaveText('Verlauf');
  });
});

test.describe('share button', () => {
  const om = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [45], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };

  test('uses the Web Share API when available, with the current level and location in the text', async ({ page }) => {
    await stubMunichGeolocation(page);
    await page.addInitScript(() => {
      window.__shareCalls = [];
      navigator.share = (data) => { window.__shareCalls.push(data); return Promise.resolve(); };
    });
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await page.locator('#shareBtn').click();

    const calls = await page.evaluate(() => window.__shareCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/München/);
    expect(calls[0].text).toMatch(/Gräser/); // dominant pollen at grass=45 K/m³
    expect(calls[0].url).toBe('https://pollen-check.netlify.app/');
  });

  test('falls back to the clipboard when the Web Share API is unavailable', async ({ page }) => {
    await stubMunichGeolocation(page);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
      window.__clipboardText = null;
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (t) => { window.__clipboardText = t; return Promise.resolve(); } },
        configurable: true,
      });
    });
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await page.locator('#shareBtn').click();

    await expect(page.locator('#shareBtn')).toHaveText('Kopiert!');
    const text = await page.evaluate(() => window.__clipboardText);
    expect(text).toMatch(/München/);
    expect(text).toMatch(/https:\/\/pollen-check\.netlify\.app\//);
  });
});

test.describe('rain hint', () => {
  // Fixed clock so "today" in the app matches the fixture's first day —
  // the hint's wording ("heute" vs "an diesem Tag") depends on that match.
  async function fixClock(page) {
    await page.addInitScript(() => {
      const RealDate = Date;
      class FixedDate extends RealDate {
        constructor(...args) { if (args.length === 0) return new RealDate(2026, 7, 17, 8, 0, 0); return new RealDate(...args); }
        static now() { return new RealDate(2026, 7, 17, 8, 0, 0).getTime(); }
      }
      window.Date = FixedDate;
    });
  }

  // grass=45 K/m³ (an active, non-'none' level) on both forecast days —
  // isolates the test to the rain/no-rain difference between the two days
  // rather than the "level is already none" suppression tested separately below.
  const om2day = { hourly: { time: ['2026-08-17T00:00', '2026-08-18T00:00'], grass_pollen: [45, 45], alder_pollen: [0, 0], birch_pollen: [0, 0], mugwort_pollen: [0, 0], ragweed_pollen: [0, 0], olive_pollen: [0, 0] } };

  test('shows the hint on a rainy day with active pollen, hides it on a dry day, and doesn\'t block the pollen render', async ({ page }) => {
    await stubMunichGeolocation(page);
    await fixClock(page);
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om2day) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));
    const weather = { daily: { time: ['2026-08-17', '2026-08-18'], precipitation_sum: [5.2, 0] } };
    await page.route('**/api.open-meteo.com/v1/forecast**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(weather) }));

    await page.goto('/');
    // The pollen list must render right away, without waiting on the
    // (separately-fetched, non-critical) weather data.
    await expect(page.locator('.pollen-list')).toBeVisible();

    await expect(page.locator('.rain-hint')).toBeVisible();
    await expect(page.locator('.rain-hint')).toContainText('Regen heute erwartet');

    await page.locator('.day-tab').nth(1).click(); // "Morgen" — dry
    await expect(page.locator('.rain-hint')).toHaveCount(0);
  });

  test('no hint when the forecasted rain is below the threshold', async ({ page }) => {
    await stubMunichGeolocation(page);
    await fixClock(page);
    const om = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [45], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(om) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));
    const weather = { daily: { time: ['2026-08-17'], precipitation_sum: [0.4] } }; // below RAIN_THRESHOLD_MM (1mm)
    await page.route('**/api.open-meteo.com/v1/forecast**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(weather) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await page.waitForTimeout(400); // let the fire-and-forget weather fetch resolve
    await expect(page.locator('.rain-hint')).toHaveCount(0);
  });

  test('no hint when the pollen level is already "none", even with plenty of rain forecasted', async ({ page }) => {
    await stubMunichGeolocation(page);
    await fixClock(page);
    const omZero = { hourly: { time: ['2026-08-17T00:00'], grass_pollen: [0], alder_pollen: [0], birch_pollen: [0], mugwort_pollen: [0], ragweed_pollen: [0], olive_pollen: [0] } };
    await page.route('**/air-quality-api.open-meteo.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(omZero) }));
    await page.route('**/dwd-api', (route) => route.abort());
    await page.route('**/lgl-api', (route) => route.abort());
    await page.route('**/.netlify/functions/history**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ history: [] }) }));
    const weather = { daily: { time: ['2026-08-17'], precipitation_sum: [10] } };
    await page.route('**/api.open-meteo.com/v1/forecast**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(weather) }));

    await page.goto('/');
    await expect(page.locator('.pollen-list')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('.rain-hint')).toHaveCount(0);
  });
});
