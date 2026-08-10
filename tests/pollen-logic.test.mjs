import { test } from 'node:test';
import assert from 'node:assert/strict';
import PollenLogic from '../pollen-logic.js';

const {
  LOCATIONS, LEVELS, SNAP_MAX_KM,
  highestLevel, fmtDate, fmtDataTimestamp, haversineKm, nearestLocation,
  parseDwdVal, extractDWDDays, processOM, processLGL, buildDays,
} = PollenLogic;

test('haversineKm: same point is 0', () => {
  assert.equal(haversineKm(48.1351, 11.5820, 48.1351, 11.5820), 0);
});

test('haversineKm: Munich to Vienna is ~355km', () => {
  const km = haversineKm(48.1351, 11.5820, 48.2082, 16.3738);
  assert.ok(km > 350 && km < 360, `expected ~355km, got ${km}`);
});

test('nearestLocation: snaps to the closest known city', () => {
  const { key, distanceKm } = nearestLocation(48.14, 11.58); // just outside Munich
  assert.equal(key, 'munich');
  assert.ok(distanceKm < 5);
});

test('nearestLocation: a distant point (Berlin) still returns something, but far beyond SNAP_MAX_KM', () => {
  const { distanceKm } = nearestLocation(52.52, 13.405);
  assert.ok(distanceKm > SNAP_MAX_KM, 'Berlin should exceed the snap threshold from every listed city');
});

test('nearestLocation: covers every configured location without throwing', () => {
  for (const loc of Object.values(LOCATIONS)) {
    const { distanceKm } = nearestLocation(loc.lat, loc.lon);
    assert.ok(distanceKm < 1, 'a location should be its own nearest match');
  }
});

test('highestLevel: picks the most severe level present', () => {
  assert.equal(highestLevel(['low', 'high', 'none']), 'high');
  assert.equal(highestLevel([]), 'none');
  assert.equal(highestLevel(['none', 'none']), 'none');
  assert.equal(LEVELS.indexOf('very-high') > LEVELS.indexOf('high'), true);
});

test('fmtDate: formats an ISO date string in German short form', () => {
  assert.equal(fmtDate('2026-08-09'), '9. Aug.');
  assert.equal(fmtDate(null), '');
  assert.equal(fmtDate(''), '');
});

test('fmtDataTimestamp: handles ISO timestamps', () => {
  const out = fmtDataTimestamp('2026-08-09T18:00:00Z');
  assert.match(out, /\d{1,2}\. August, \d{2}:\d{2} Uhr/);
});

test('fmtDataTimestamp: handles "YYYY-MM-DD HH:MM" style strings', () => {
  const out = fmtDataTimestamp('2026-08-09 18:00');
  assert.match(out, /\d{1,2}\. August, 18:00 Uhr/);
});

test('fmtDataTimestamp: empty input returns empty string', () => {
  assert.equal(fmtDataTimestamp(null), '');
  assert.equal(fmtDataTimestamp(''), '');
});

test('parseDwdVal: maps known DWD codes to level/display/pct', () => {
  assert.deepEqual(parseDwdVal('0'), { level: 'none', display: '0', unit: '/ 3', source: 'dwd', pct: 0 });
  const highish = parseDwdVal('2-3');
  assert.equal(highish.level, 'high');
  assert.equal(highish.display, '2.5');
  assert.equal(highish.pct, 83);
});

test('parseDwdVal: "-1" and unknown codes are null (no data)', () => {
  assert.equal(parseDwdVal('-1'), null);
  assert.equal(parseDwdVal(null), null);
  assert.equal(parseDwdVal('nonsense'), null);
});

test('extractDWDDays: reads the matching partregion and produces 3 days when last_update is today', () => {
  const raw = {
    last_update: '2026-08-09 12:00',
    content: [
      {
        partregion_id: 121,
        Pollen: {
          Birke: { today: '1', tomorrow: '1-2', dayafter_to: '0' },
          Graeser: { today: '2', tomorrow: '2', dayafter_to: '2-3' },
        },
      },
    ],
  };
  // last_update's date matches "today" -> no staleness, straight 0/1/2 mapping.
  const referenceDate = new Date(2026, 7, 9, 10, 0);
  const result = extractDWDDays(raw, 121, referenceDate);
  assert.equal(result.days.length, 3);
  assert.equal(result.lastUpdate, '2026-08-09 12:00');
  assert.equal(result.days[0].date, '2026-08-09');
  assert.equal(result.days[0].dwd.birch.level, 'low');
  assert.equal(result.days[1].dwd.birch.level, 'medium');
  assert.equal(result.days[2].dwd.birch.level, 'none'); // '0' is a valid code, not "no data"
});

test('extractDWDDays: unknown partregion returns null', () => {
  const raw = { last_update: '2026-08-09 12:00', content: [{ partregion_id: 999, Pollen: {} }] };
  assert.equal(extractDWDDays(raw, 121, new Date(2026, 7, 9)), null);
});

test('extractDWDDays: a last_update stuck on yesterday (not-yet-refreshed) does not mislabel stale data as "today"', () => {
  // Regression test for a real bug: before DWD's daily refresh lands,
  // last_update can still be yesterday's date. The 3-day window must stay
  // anchored on the real current date, shifting which DWD field maps to
  // which calendar day instead of presenting yesterday's now-elapsed
  // "today" forecast as if it were current.
  const raw = {
    last_update: '2026-08-09 12:00', // stuck on yesterday
    content: [{
      partregion_id: 121,
      Pollen: {
        // today = yesterday's now-elapsed forecast, tomorrow = real today,
        // dayafter_to = real tomorrow. Distinct levels so a wrong field
        // mapping fails loudly instead of coincidentally matching.
        Birke: { today: '3', tomorrow: '1', dayafter_to: '2-3' },
      },
    }],
  };
  const referenceDate = new Date(2026, 7, 10, 7, 50); // real "today" is 2026-08-10
  const result = extractDWDDays(raw, 121, referenceDate);

  assert.equal(result.days[0].date, '2026-08-10'); // real today, not last_update's date
  assert.equal(result.days[1].date, '2026-08-11');
  assert.equal(result.days[2].date, '2026-08-12');

  // Real "today" (2026-08-10) must use DWD's 'tomorrow' field (index 1),
  // not 'today' (which describes the now-elapsed 2026-08-09) -> 'low', not 'high'.
  assert.equal(result.days[0].dwd.birch.level, 'low');
  // Real "tomorrow" (2026-08-11) must use DWD's 'dayafter_to' field (index 2) -> 'high'.
  assert.equal(result.days[1].dwd.birch.level, 'high');
  // Real day-after (2026-08-12) is beyond DWD's 3-day window from its stale
  // publish date -> no DWD data for it (falls back to other sources upstream).
  assert.equal(result.days[2].dwd, null);
});

test('processOM: takes the daily max per pollen and buckets into levels', () => {
  const raw = {
    hourly: {
      time: ['2026-08-09T00:00', '2026-08-09T12:00', '2026-08-10T00:00'],
      birch_pollen: [5, 100, 0],   // day 1 max 100 -> above thr[1]=90 -> 'high' (below 1500)
      grass_pollen: [0, 5, 0],     // day 1 max 5 -> below 10 -> 'low'
    },
  };
  const days = processOM(raw);
  assert.equal(days.length, 2);
  assert.equal(days[0].om.birch.level, 'high');
  assert.equal(days[0].om.grass.level, 'low');
  assert.equal(days[1].om.birch.level, 'none');
});

test('processLGL: picks the max reading per station and returns the latest "to" timestamp', () => {
  const raw = {
    measurements: [
      { location: 'DEMUNC', polle: 'Betula', data: [{ value: 50, to: 1000 }, { value: 10, to: 2000 }] },
      { location: 'DEMUNC', polle: 'Ambrosia', data: [{ value: 1000, to: 1500 }] }, // very-high
      { location: 'DEFEUC', polle: 'Betula', data: [{ value: 999, to: 9999 }] },     // different station, ignored
    ],
  };
  const result = processLGL(raw, 'DEMUNC');
  assert.equal(result.data.birch.level, 'medium'); // max(50,10)=50, thr [1,20,200,1000] -> 'medium'
  assert.equal(result.data.ragweed.level, 'very-high');
  assert.equal(result.dataDate, new Date(2000 * 1000).toISOString());
});

test('processLGL: no matching station returns null', () => {
  const raw = { measurements: [{ location: 'OTHER', polle: 'Betula', data: [{ value: 5, to: 1 }] }] };
  assert.equal(processLGL(raw, 'DEMUNC'), null);
});

test('buildDays: LGL takes priority over DWD, DWD over Open-Meteo', () => {
  const dwdDays = [{ date: '2026-08-09', dwd: { birch: { level: 'low', source: 'dwd' }, grass: { level: 'medium', source: 'dwd' } } }];
  const omDays  = [{ date: '2026-08-09', om: { birch: { level: 'high', source: 'om', display: '123' }, ragweed: { level: 'low', source: 'om' } } }];
  const lglToday = { birch: { level: 'very-high', source: 'lgl' } };

  const days = buildDays(dwdDays, omDays, lglToday);
  assert.equal(days[0].pollens.birch.level, 'very-high'); // LGL wins
  assert.equal(days[0].pollens.birch.source, 'lgl');
  assert.equal(days[0].pollens.grass.level, 'medium');    // DWD wins (no LGL entry)
  assert.equal(days[0].pollens.grass.source, 'dwd');
  assert.equal(days[0].pollens.ragweed.level, 'low');     // Open-Meteo only
  assert.equal(days[0].pollens.hazel, null);               // no data anywhere
});

test('buildDays: DWD entries get an omDisplay hint when Open-Meteo also has data', () => {
  const dwdDays = [{ date: '2026-08-09', dwd: { birch: { level: 'low', source: 'dwd' } } }];
  const omDays  = [{ date: '2026-08-09', om: { birch: { level: 'high', source: 'om', display: '77' } } }];
  const days = buildDays(dwdDays, omDays, null);
  assert.equal(days[0].pollens.birch.omDisplay, '77');
});

test('buildDays: always produces at least 3 days even with no data', () => {
  const days = buildDays(null, null, null);
  assert.equal(days.length, 3);
  assert.equal(days[0].pollens.birch, null);
});
