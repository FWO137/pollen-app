import { test } from 'node:test';
import assert from 'node:assert/strict';
import PollenLogic from '../pollen-logic.js';

const {
  LOCATIONS, LEVELS, SNAP_MAX_KM, LGL_MAX_KM,
  highestLevel, overallLevel, isInSeason, fmtDate, fmtDataTimestamp, haversineKm, nearestLocation, nearestLglStation, normalizeAllergenKeys,
  parseDwdVal, extractDWDDays, processOM, processLGL, buildDays, processWeather,
  pollenDisplay, diffTodayPollens, formatChangeNotification,
  SYMPTOM_KEEP_DAYS, SYMPTOM_NOTE_MAX,
  localDateStr, addDays, sanitizeSymptomEntries, pruneSymptomEntries, upsertSymptomEntry, mergeSymptomsWithHistory,
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

test('nearestLglStation: only monitors within 30 km of the forecast point', () => {
  const munich = nearestLglStation(LOCATIONS.munich.lat, LOCATIONS.munich.lon);
  assert.equal(munich.id, 'DEMUNC');
  assert.equal(munich.name, 'München');
  assert.ok(munich.distanceKm <= LGL_MAX_KM);

  const nuremberg = nearestLglStation(LOCATIONS.nuremberg.lat, LOCATIONS.nuremberg.lon);
  assert.equal(nuremberg.id, 'DEFEUC');
  assert.equal(nuremberg.name, 'Feucht');

  // 29.5 km — the Altötting monitor still covers this anchor.
  const pfarrkirchen = nearestLglStation(LOCATIONS.pfarrkirchen.lat, LOCATIONS.pfarrkirchen.lon);
  assert.equal(pfarrkirchen.id, 'DEALTO');
  assert.equal(pfarrkirchen.name, 'Altötting');

  // These cities used to inherit a monitor 47–70 km away.
  for (const key of ['augsburg', 'ingolstadt', 'regensburg', 'ulm', 'innsbruck']) {
    assert.equal(nearestLglStation(LOCATIONS[key].lat, LOCATIONS[key].lon), null, key);
  }
  assert.equal(nearestLglStation(Number.NaN, 11), null);
});

test('normalizeAllergenKeys: null means every pollen, unknown keys are dropped', () => {
  assert.equal(normalizeAllergenKeys(undefined), null);
  assert.equal(normalizeAllergenKeys('birch'), null);
  assert.equal(normalizeAllergenKeys([]), null);
  assert.equal(normalizeAllergenKeys(['nope']), null);
  assert.deepEqual(normalizeAllergenKeys(['grass', 'nope', 'grass', 'birch']), ['birch', 'grass']);
  assert.equal(normalizeAllergenKeys(['hazel', 'alder', 'ash', 'birch', 'plane', 'olive', 'grass', 'rye', 'mugwort', 'ragweed']), null);
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

test('processWeather: maps daily precipitation_sum onto its date', () => {
  const raw = { daily: { time: ['2026-08-17', '2026-08-18'], precipitation_sum: [0, 3.4] } };
  const byDate = processWeather(raw);
  assert.deepEqual(byDate, { '2026-08-17': 0, '2026-08-18': 3.4 });
});

test('processWeather: missing/malformed input returns an empty map instead of throwing', () => {
  assert.deepEqual(processWeather({}), {});
  assert.deepEqual(processWeather(null), {});
  assert.deepEqual(processWeather({ daily: { time: ['2026-08-17'] } }), { '2026-08-17': 0 }); // no precipitation_sum array -> defaults to 0
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

test('buildDays: a DWD row keeps its own level and scale when Open-Meteo disagrees', () => {
  // Colour, number and bar have to describe the same source. DWD says low
  // (1 / 3); Open-Meteo would have said high — the DWD entry wins whole.
  const dwdDays = [{ date: '2026-08-09', dwd: { birch: { level: 'low', display: '1', unit: '/ 3', pct: 33, source: 'dwd' } } }];
  const omDays  = [{ date: '2026-08-09', om: { birch: { level: 'high', display: '77', unit: 'K/m³', pct: 92, source: 'om' } } }];
  const days = buildDays(dwdDays, omDays, null);
  const birch = days[0].pollens.birch;
  assert.equal(birch.level, 'low');
  assert.equal(birch.display, '1');
  assert.equal(birch.unit, '/ 3');
  assert.equal(birch.pct, 33);
  assert.equal(birch.source, 'dwd');
  assert.equal(birch.omDisplay, undefined);
  assert.deepEqual(pollenDisplay(birch), { value: '1', unit: '/ 3', pct: 33 });
});

test('buildDays: DWD entries with no Open-Meteo coverage stay on the DWD scale', () => {
  const dwdDays = [{ date: '2026-08-09', dwd: { hazel: { level: 'low', display: '1', unit: '/ 3', source: 'dwd' } } }];
  const days = buildDays(dwdDays, null, null);
  assert.equal(days[0].pollens.hazel.display, '1');
  assert.equal(days[0].pollens.hazel.unit, '/ 3');
});

test('buildDays: always produces at least 3 days even with no data', () => {
  const days = buildDays(null, null, null);
  assert.equal(days.length, 3);
  assert.equal(days[0].pollens.birch, null);
});

test('pollenDisplay: ignores a legacy omDisplay so the figure matches entry.level', () => {
  const entry = { level: 'medium', display: '1.5', unit: '/ 3', pct: 50, omDisplay: '45', omPct: 43 };
  assert.deepEqual(pollenDisplay(entry), { value: '1.5', unit: '/ 3', pct: 50 });
});

test('pollenDisplay: falls back to the native display/unit/pct when there is no omDisplay', () => {
  const entry = { level: 'low', display: '1', unit: '/ 3', pct: 33 };
  assert.deepEqual(pollenDisplay(entry), { value: '1', unit: '/ 3', pct: 33 });
});

test('pollenDisplay: null entry -> null', () => {
  assert.equal(pollenDisplay(null), null);
});

test('diffTodayPollens: flags a level change even if the level text differs but nothing else', () => {
  const prev = { grass: { level: 'low', display: '1', unit: '/ 3', pct: 33 } };
  const curr = { grass: { level: 'medium', display: '2', unit: '/ 3', pct: 67 } };
  const changes = diffTodayPollens(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].key, 'grass');
  assert.equal(changes[0].prevLevel, 'low');
  assert.equal(changes[0].currLevel, 'medium');
  assert.equal(changes[0].currValue, '2 / 3');
});

test('diffTodayPollens: a value change inside the same level is not a change', () => {
  const prev = { grass: { level: 'medium', display: '45', unit: 'K/m³', pct: 43 } };
  const curr = { grass: { level: 'medium', display: '48', unit: 'K/m³', pct: 45 } };
  assert.deepEqual(diffTodayPollens(prev, curr), []);
});

test('diffTodayPollens: a drop in level is not a change', () => {
  const prev = { grass: { level: 'high', display: '80', unit: 'K/m³', pct: 80 } };
  const curr = { grass: { level: 'low', display: '5', unit: 'K/m³', pct: 20 } };
  assert.deepEqual(diffTodayPollens(prev, curr), []);
});

test('diffTodayPollens: keys filter and skipKeys limit who can rise', () => {
  const prev = { grass: { level: 'low', display: '5', unit: 'K/m³' }, birch: { level: 'none', display: '0', unit: 'K/m³' } };
  const curr = { grass: { level: 'high', display: '80', unit: 'K/m³' }, birch: { level: 'low', display: '20', unit: 'K/m³' } };
  assert.deepEqual(diffTodayPollens(prev, curr, { keys: ['birch'] }).map((c) => c.key), ['birch']);
  assert.deepEqual(diffTodayPollens(prev, curr, { skipKeys: ['grass'] }).map((c) => c.key), ['birch']);
  assert.deepEqual(diffTodayPollens(prev, curr, { keys: ['grass'], skipKeys: ['grass'] }), []);
});

test('diffTodayPollens: identical data -> no changes', () => {
  const pollens = { grass: { level: 'medium', omDisplay: '45', omPct: 43 }, birch: null };
  assert.deepEqual(diffTodayPollens(pollens, pollens), []);
});

test('diffTodayPollens: a pollen appearing above "none" for the first time counts as an increase', () => {
  const prev = { ragweed: null };
  const curr = { ragweed: { level: 'low', display: '3', unit: 'K/m³', pct: 10 } };
  const changes = diffTodayPollens(prev, curr);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].prevValue, null);
  assert.equal(changes[0].currValue, '3 K/m³');
});

test('diffTodayPollens: null vs undefined previous state are treated the same (no false positives)', () => {
  const curr = { grass: { level: 'none', omDisplay: '0', omPct: 0 } };
  assert.deepEqual(diffTodayPollens(undefined, curr), diffTodayPollens(null, curr));
});

test('formatChangeNotification: includes the location, overall level, and the new value per change', () => {
  const changes = [
    { key: 'grass', name: 'Gräser', prevLevel: 'low', currLevel: 'medium', prevValue: '5 K/m³', currValue: '9 K/m³' },
    { key: 'mugwort', name: 'Beifuß', prevLevel: 'none', currLevel: 'low', prevValue: null, currValue: '1 K/m³' },
  ];
  const { title, body } = formatChangeNotification(changes, 'low', 'Pfarrkirchen');
  assert.equal(title, 'Pollenwerte aktualisiert – Pfarrkirchen');
  assert.match(body, /Geringe Belastung/);
  assert.match(body, /Gräser: 9 K\/m³/);
  assert.match(body, /Beifuß: 1 K\/m³/);
});

test('overallLevel: takes the highest level across all pollens, defaulting missing ones to none', () => {
  const pollens = { grass: { level: 'medium' }, birch: { level: 'high' }, hazel: null };
  assert.equal(overallLevel(pollens), 'high');
  assert.equal(overallLevel({}), 'none');
  assert.equal(overallLevel(null), 'none');
});

test('overallLevel: no filter / null / undefined filter all behave exactly like before', () => {
  const pollens = { grass: { level: 'medium' }, birch: { level: 'high' }, hazel: null };
  assert.equal(overallLevel(pollens, undefined), 'high');
  assert.equal(overallLevel(pollens, null), 'high');
});

test('overallLevel: with a key filter, only the selected pollens count', () => {
  const pollens = { grass: { level: 'medium' }, birch: { level: 'very-high' }, ragweed: { level: 'low' } };
  assert.equal(overallLevel(pollens, ['grass']), 'medium');         // birch is higher but not selected
  assert.equal(overallLevel(pollens, ['grass', 'ragweed']), 'medium');
  assert.equal(overallLevel(pollens, ['ragweed', 'birch']), 'very-high');
  assert.equal(overallLevel(pollens, ['hazel']), 'none');           // selected pollen has no data
});

test('overallLevel: filter accepts any iterable (e.g. a Set) and ignores unknown keys', () => {
  const pollens = { grass: { level: 'low' }, birch: { level: 'high' } };
  assert.equal(overallLevel(pollens, new Set(['grass'])), 'low');
  assert.equal(overallLevel(pollens, ['does-not-exist', 'grass']), 'low');
  assert.equal(overallLevel(pollens, ['does-not-exist']), 'none');
});

test('overallLevel: an empty filter selects nothing -> none', () => {
  const pollens = { birch: { level: 'high' } };
  assert.equal(overallLevel(pollens, []), 'none');
  assert.equal(overallLevel(null, ['birch']), 'none');
});

test('isInSeason: pollens outside their season window are correctly flagged', () => {
  // Birke: Apr – Mai
  assert.equal(isInSeason('birch', '2026-04-15'), true);
  assert.equal(isInSeason('birch', '2026-05-31'), true);
  assert.equal(isInSeason('birch', '2026-01-15'), false);
  assert.equal(isInSeason('birch', '2026-08-17'), false);
});

test('isInSeason: Ambrosia (Aug – Okt) matches the reported real-world scenario', () => {
  assert.equal(isInSeason('ragweed', '2026-08-17'), true);
  assert.equal(isInSeason('ragweed', '2026-11-01'), false);
  assert.equal(isInSeason('ragweed', '2026-07-31'), false);
});

test('isInSeason: unknown pollen key or missing season data defaults to true (never falsely claims "out of season")', () => {
  assert.equal(isInSeason('does-not-exist', '2026-08-17'), true);
});

test('localDateStr: uses the local calendar date, not the UTC one', () => {
  // 00:30 local is still the previous day in UTC for any timezone east of
  // UTC (e.g. Europe/Berlin) — the local date must win.
  assert.equal(localDateStr(new Date(2026, 8, 28, 0, 30)), '2026-09-28');
  assert.equal(localDateStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('addDays: crosses month/year boundaries and DST switches without skipping a date', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2026-03-28', 1), '2026-03-29'); // DST starts 2026-03-29 in DE/AT
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
  assert.equal(addDays('2026-10-25', -1), '2026-10-24'); // DST ends 2026-10-25
});

test('sanitizeSymptomEntries: drops malformed entries, dedupes by date (last wins), sorts and trims notes', () => {
  const raw = [
    { date: '2026-09-27', severity: 'severe', note: '  Augen jucken  ' },
    { date: '2026-09-25', severity: 'mild' },                    // missing note -> ''
    { date: '2026-09-27', severity: 'moderate', note: 'später' }, // same day again -> replaces the first
    { date: '2026-09-26', severity: 'terrible', note: 'x' },     // unknown severity
    { date: '26.09.2026', severity: 'mild', note: '' },          // wrong date format
    null,
    'garbage',
  ];
  assert.deepEqual(sanitizeSymptomEntries(raw), [
    { date: '2026-09-25', severity: 'mild', note: '' },
    { date: '2026-09-27', severity: 'moderate', note: 'später' },
  ]);
});

test('sanitizeSymptomEntries: non-array input (corrupt localStorage) returns an empty list instead of throwing', () => {
  assert.deepEqual(sanitizeSymptomEntries(null), []);
  assert.deepEqual(sanitizeSymptomEntries({ date: '2026-09-27', severity: 'mild' }), []);
});

test('sanitizeSymptomEntries: caps overly long notes at SYMPTOM_NOTE_MAX', () => {
  const [e] = sanitizeSymptomEntries([{ date: '2026-09-27', severity: 'mild', note: 'a'.repeat(1000) }]);
  assert.equal(e.note.length, SYMPTOM_NOTE_MAX);
});

test('upsertSymptomEntry: adds a new day and keeps the list sorted', () => {
  const entries = [{ date: '2026-09-26', severity: 'mild', note: '' }];
  const out = upsertSymptomEntry(entries, { date: '2026-09-28', severity: 'severe', note: 'Niesen' }, '2026-09-28');
  assert.deepEqual(out.map((e) => e.date), ['2026-09-26', '2026-09-28']);
  assert.equal(out[1].severity, 'severe');
});

test('upsertSymptomEntry: saving again on the same day edits that day\'s entry instead of adding a second one', () => {
  const entries = [{ date: '2026-09-28', severity: 'mild', note: 'morgens' }];
  const out = upsertSymptomEntry(entries, { date: '2026-09-28', severity: 'moderate', note: 'abends schlimmer' }, '2026-09-28');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { date: '2026-09-28', severity: 'moderate', note: 'abends schlimmer' });
});

test('upsertSymptomEntry: prunes entries older than SYMPTOM_KEEP_DAYS when saving', () => {
  const today = '2026-09-28';
  const entries = [
    { date: addDays(today, -SYMPTOM_KEEP_DAYS), severity: 'mild', note: '' },       // 91st day back -> dropped
    { date: addDays(today, -(SYMPTOM_KEEP_DAYS - 1)), severity: 'mild', note: '' }, // exactly 90 days incl. today -> kept
  ];
  const out = upsertSymptomEntry(entries, { date: today, severity: 'none', note: '' }, today);
  assert.deepEqual(out.map((e) => e.date), [addDays(today, -(SYMPTOM_KEEP_DAYS - 1)), today]);
});

test('upsertSymptomEntry: an invalid entry is ignored and the input list is never mutated', () => {
  const entries = [{ date: '2026-09-27', severity: 'mild', note: '' }];
  const snapshot = JSON.parse(JSON.stringify(entries));
  const out = upsertSymptomEntry(entries, { date: '2026-09-28', severity: 'nope' }, '2026-09-28');
  assert.deepEqual(out, snapshot);
  upsertSymptomEntry(entries, { date: '2026-09-27', severity: 'severe', note: 'x' }, '2026-09-28');
  assert.deepEqual(entries, snapshot);
});

test('pruneSymptomEntries: keeps exactly the last keepDays calendar days', () => {
  const entries = [
    { date: '2026-09-20', severity: 'mild', note: '' },
    { date: '2026-09-21', severity: 'mild', note: '' },
    { date: '2026-09-28', severity: 'mild', note: '' },
  ];
  assert.deepEqual(pruneSymptomEntries(entries, '2026-09-28', 8).map((e) => e.date), ['2026-09-21', '2026-09-28']);
});

test('mergeSymptomsWithHistory: lines up symptom entries with pollen history by date', () => {
  const history = [
    { date: '2026-09-26', overall: 'high', pollens: {} },
    { date: '2026-09-27', overall: 'low', pollens: {} },
  ];
  const symptoms = [
    { date: '2026-09-26', severity: 'severe', note: '' },
    { date: '2026-09-28', severity: 'mild', note: '' }, // no history for today yet
  ];
  const rows = mergeSymptomsWithHistory(history, symptoms, '2026-09-28');
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-26', '2026-09-27', '2026-09-28']);
  assert.equal(rows[0].pollen.overall, 'high');
  assert.equal(rows[0].symptom.severity, 'severe');
  assert.equal(rows[1].symptom, null); // history but no entry that day
  assert.equal(rows[2].pollen, null);  // entry but no history that day
  assert.equal(rows[2].symptom.severity, 'mild');
});

test('mergeSymptomsWithHistory: with no symptoms it is exactly the last `days` history entries (existing trend behavior)', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ date: addDays('2026-08-01', i), overall: 'low', pollens: {} }));
  const rows = mergeSymptomsWithHistory(history, [], '2026-09-28', 7);
  assert.deepEqual(rows.map((r) => r.date), history.slice(-7).map((h) => h.date));
  assert.ok(rows.every((r) => r.symptom === null));
});

test('mergeSymptomsWithHistory: no pollen history (not subscribed) still returns the symptom entries alone', () => {
  const symptoms = [
    { date: '2026-09-27', severity: 'moderate', note: '' },
    { date: '2026-09-28', severity: 'none', note: '' },
  ];
  for (const history of [null, []]) {
    const rows = mergeSymptomsWithHistory(history, symptoms, '2026-09-28');
    assert.deepEqual(rows.map((r) => r.date), ['2026-09-27', '2026-09-28']);
    assert.ok(rows.every((r) => r.pollen === null));
    assert.equal(rows[0].symptom.severity, 'moderate');
  }
});

test('mergeSymptomsWithHistory: ignores symptom entries outside the recent window (too old, or dated in the future)', () => {
  const symptoms = [
    { date: '2026-09-14', severity: 'severe', note: '' }, // 15 days back -> outside a 14-day window
    { date: '2026-09-15', severity: 'mild', note: '' },   // 14th day back incl. today -> inside
    { date: '2026-09-29', severity: 'mild', note: '' },   // tomorrow (device clock changed) -> ignored
  ];
  const rows = mergeSymptomsWithHistory(null, symptoms, '2026-09-28', 7, 14);
  assert.deepEqual(rows.map((r) => r.date), ['2026-09-15']);
});

test('mergeSymptomsWithHistory: no data from either side -> empty list', () => {
  assert.deepEqual(mergeSymptomsWithHistory(null, null, '2026-09-28'), []);
  assert.deepEqual(mergeSymptomsWithHistory([], [], '2026-09-28'), []);
});
