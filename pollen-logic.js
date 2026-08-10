// Pure data logic for the Pollenflug app: location/pollen tables, unit
// conversion & threshold mapping for each data source, and day-merging.
// No DOM, no fetch — safe to load in a browser <script> tag (attaches to
// `window.PollenLogic`) or `require()`/`import` from a Node test file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PollenLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ─── Locations ───────────────────────────────────────────────────────────────
  const LOCATIONS = {
    pfarrkirchen: { name: 'Pfarrkirchen', lat: 48.4320, lon: 12.9386, country: 'DE', dwd: 122, lgl: 'DEALTO' },
    munich:       { name: 'München',      lat: 48.1351, lon: 11.5820, country: 'DE', dwd: 121, lgl: 'DEMUNC' },
    nuremberg:    { name: 'Nürnberg',     lat: 49.4521, lon: 11.0767, country: 'DE', dwd: 123, lgl: 'DEFEUC' },
    augsburg:     { name: 'Augsburg',     lat: 48.3705, lon: 10.8978, country: 'DE', dwd: 121, lgl: 'DEMIND' },
    ingolstadt:   { name: 'Ingolstadt',   lat: 48.7665, lon: 11.4258, country: 'DE', dwd: 121, lgl: 'DEMUNC' },
    regensburg:   { name: 'Regensburg',   lat: 49.0134, lon: 12.1016, country: 'DE', dwd: 123, lgl: 'DEVIEC' },
    stuttgart:    { name: 'Stuttgart',    lat: 48.7758, lon:  9.1829, country: 'DE', dwd: 112, lgl: null     },
    freiburg:     { name: 'Freiburg',     lat: 47.9990, lon:  7.8421, country: 'DE', dwd: 111, lgl: null     },
    ulm:          { name: 'Ulm',          lat: 48.4011, lon:  9.9876, country: 'DE', dwd: 112, lgl: 'DEMIND' },
    constance:    { name: 'Konstanz',     lat: 47.6631, lon:  9.1756, country: 'DE', dwd: 112, lgl: null     },
    vienna:       { name: 'Wien',         lat: 48.2082, lon: 16.3738, country: 'AT', dwd: null, lgl: null    },
    salzburg:     { name: 'Salzburg',     lat: 47.8095, lon: 13.0550, country: 'AT', dwd: null, lgl: null    },
    innsbruck:    { name: 'Innsbruck',    lat: 47.2692, lon: 11.4041, country: 'AT', dwd: null, lgl: null    },
    graz:         { name: 'Graz',         lat: 47.0707, lon: 15.4395, country: 'AT', dwd: null, lgl: null    },
    linz:         { name: 'Linz',         lat: 48.3069, lon: 14.2858, country: 'AT', dwd: null, lgl: null    },
    klagenfurt:   { name: 'Klagenfurt',   lat: 46.6228, lon: 14.3051, country: 'AT', dwd: null, lgl: null    },
    bregenz:      { name: 'Bregenz',      lat: 47.5031, lon:  9.7471, country: 'AT', dwd: null, lgl: null    },
  };

  // ─── Pollen types ────────────────────────────────────────────────────────────
  const POLLEN = [
    { key: 'hazel',   name: 'Hasel',    en: 'Hazel',   season: 'Jan – Mär', icon: '🌰', dwd: 'Hasel',    om: null              },
    { key: 'alder',   name: 'Erle',     en: 'Alder',   season: 'Jan – Apr', icon: '🌳', dwd: 'Erle',     om: 'alder_pollen'    },
    { key: 'ash',     name: 'Esche',    en: 'Ash',     season: 'Mär – Mai', icon: '🌿', dwd: 'Esche',    om: null              },
    { key: 'birch',   name: 'Birke',    en: 'Birch',   season: 'Apr – Mai', icon: '🌲', dwd: 'Birke',    om: 'birch_pollen'    },
    { key: 'plane',   name: 'Platane',  en: 'Plane',   season: 'Apr – Mai', icon: '🌴', dwd: null,       om: null              },
    { key: 'olive',   name: 'Olive',    en: 'Olive',   season: 'Mai – Jun', icon: '🫒', dwd: null,       om: 'olive_pollen'    },
    { key: 'grass',   name: 'Gräser',   en: 'Grass',   season: 'Mai – Sep', icon: '🌾', dwd: 'Graeser',  om: 'grass_pollen'    },
    { key: 'rye',     name: 'Roggen',   en: 'Rye',     season: 'Mai – Jun', icon: '🌻', dwd: 'Roggen',   om: null              },
    { key: 'mugwort', name: 'Beifuß',   en: 'Mugwort', season: 'Jul – Sep', icon: '🍃', dwd: 'Beifuss',  om: 'mugwort_pollen'  },
    { key: 'ragweed', name: 'Ambrosia', en: 'Ragweed', season: 'Aug – Okt', icon: '🌱', dwd: 'Ambrosia', om: 'ragweed_pollen'  },
  ];

  const LGL_MAP = {
    Alnus: 'alder', Betula: 'birch', Platanus: 'plane', Fraxinus: 'ash',
    Corylus: 'hazel', Poaceae: 'grass', Secale: 'rye',
    Artemisia: 'mugwort', Ambrosia: 'ragweed',
  };

  const LGL_THR = {
    Alnus:    [1,  20, 200, 1000],
    Betula:   [1,  20, 200, 1000],
    Platanus: [1,  20, 200, 1000],
    Fraxinus: [1,  20, 200, 1000],
    Corylus:  [1,  20, 200, 1000],
    Poaceae:  [1,  10, 100,  500],
    Secale:   [1,  10, 100,  500],
    Artemisia:[1,  20, 200, 1000],
    Ambrosia: [1,  10,  50,  200],
  };

  const OM_THR = {
    alder_pollen:   [15,  90,  500],
    birch_pollen:   [15,  90, 1500],
    grass_pollen:   [10,  50,  200],
    mugwort_pollen: [10,  50,  200],
    ragweed_pollen: [10,  50,  200],
    olive_pollen:   [10,  50,  200],
  };

  const DWD_MAP = {
    '0':   { level: 'none',   num: 0   },
    '0-1': { level: 'low',    num: 0.5 },
    '1':   { level: 'low',    num: 1   },
    '1-2': { level: 'medium', num: 1.5 },
    '2':   { level: 'medium', num: 2   },
    '2-3': { level: 'high',   num: 2.5 },
    '3':   { level: 'high',   num: 3   },
  };

  const LEVELS      = ['none', 'low', 'medium', 'high', 'very-high'];
  const SUMMARY_DE  = { none: 'Kaum Belastung', low: 'Geringe Belastung', medium: 'Mittlere Belastung', high: 'Hohe Belastung', 'very-high': 'Sehr hohe Belastung' };

  // Beyond this distance (km) from the nearest known city, its DWD region /
  // LGL station is no longer a reasonable stand-in — fall back to
  // Open-Meteo with the real coordinates instead of misattributing data.
  const SNAP_MAX_KM = 80;

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function highestLevel(levels) {
    return levels.reduce((best, l) =>
      LEVELS.indexOf(l) > LEVELS.indexOf(best) ? l : best, 'none');
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
  }

  function fmtDataTimestamp(ts) {
    if (!ts) return '';
    let date, timeStr;
    if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
      date = new Date(ts);
      timeStr = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
    } else {
      const [datePart] = ts.split(' ');
      date = new Date(datePart + 'T12:00:00');
      const m = ts.match(/\d{2}:\d{2}/);
      timeStr = m ? m[0] : null;
    }
    const dateStr = date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' });
    return timeStr ? `${dateStr}, ${timeStr} Uhr` : dateStr;
  }

  // Great-circle distance in km (haversine) — accurate for nearest-city
  // matching, unlike a raw Euclidean distance on lat/lon degrees.
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function nearestLocation(lat, lon) {
    let key = 'munich', distanceKm = Infinity;
    for (const [k, loc] of Object.entries(LOCATIONS)) {
      const d = haversineKm(lat, lon, loc.lat, loc.lon);
      if (d < distanceKm) { distanceKm = d; key = k; }
    }
    return { key, distanceKm };
  }

  // ─── DWD ─────────────────────────────────────────────────────────────────────
  function parseDwdVal(str) {
    if (!str || str === '-1') return null;
    const e = DWD_MAP[str];
    if (!e) return null;
    const display = Number.isInteger(e.num) ? String(e.num) : e.num.toFixed(1);
    return { level: e.level, display, unit: '/ 3', source: 'dwd', pct: Math.round(e.num / 3 * 100) };
  }

  const DWD_FIELDS = ['today', 'tomorrow', 'dayafter_to'];

  // `referenceDate` is the real current moment (injectable for tests).
  // DWD publishes once a day; its `last_update` (and hence its 'today'
  // field) can still describe *yesterday* in the hours before that day's
  // refresh lands. Anchoring the 3-day window on `last_update` — like this
  // function used to — silently mislabels a stale forecast as "today"
  // instead of comparing it against the real current date and shifting
  // which DWD field ('today'/'tomorrow'/'dayafter_to') maps to which real
  // calendar day, dropping whatever falls outside DWD's 3-day window.
  function extractDWDDays(raw, partregionId, referenceDate = new Date()) {
    const region = raw.content.find(r => r.partregion_id === partregionId);
    if (!region) return null;
    const p = region.Pollen;

    const lastUpdateDate = new Date(raw.last_update.split(' ')[0] + 'T12:00:00');
    const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 12);
    const staleDays = Math.round((today - lastUpdateDate) / 86400000);

    const days = [0, 1, 2].map(i => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const field = DWD_FIELDS[staleDays + i]; // undefined if outside DWD's window
      return {
        date: d.toISOString().split('T')[0],
        dwd: field ? {
          hazel:   parseDwdVal(p.Hasel?.[field]),
          alder:   parseDwdVal(p.Erle?.[field]),
          ash:     parseDwdVal(p.Esche?.[field]),
          birch:   parseDwdVal(p.Birke?.[field]),
          grass:   parseDwdVal(p.Graeser?.[field]),
          rye:     parseDwdVal(p.Roggen?.[field]),
          mugwort: parseDwdVal(p.Beifuss?.[field]),
          ragweed: parseDwdVal(p.Ambrosia?.[field]),
        } : null,
      };
    });
    return { days, lastUpdate: raw.last_update };
  }

  // ─── Open-Meteo ──────────────────────────────────────────────────────────────
  function processOM(raw) {
    const times = raw.hourly.time;
    const byDay = {};
    for (let i = 0; i < times.length; i++) {
      const date = times[i].split('T')[0];
      if (!byDay[date]) byDay[date] = { date };
      for (const p of POLLEN) {
        if (!p.om) continue;
        const v = raw.hourly[p.om]?.[i] ?? 0;
        byDay[date][p.key] = Math.max(byDay[date][p.key] ?? 0, v || 0);
      }
    }
    return Object.values(byDay)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(day => {
        const om = {};
        for (const p of POLLEN) {
          if (!p.om) continue;
          const v = day[p.key] || 0;
          const thr = OM_THR[p.om] || [10, 50, 200];
          const level = v < 0.5 ? 'none'
            : v < thr[0] ? 'low'
            : v < thr[1] ? 'medium'
            : v < thr[2] ? 'high' : 'very-high';
          const display = v < 1 ? '0' : Math.round(v).toLocaleString('de-DE');
          let pct;
          if (v < 0.5)         pct = 0;
          else if (v < thr[0]) pct = Math.round((v / thr[0]) * 33);
          else if (v < thr[1]) pct = Math.round(33 + (v - thr[0]) / (thr[1] - thr[0]) * 33);
          else                 pct = Math.min(Math.round(66 + (v - thr[1]) / (thr[2] - thr[1]) * 34), 100);
          om[p.key] = { level, display, unit: 'K/m³', source: 'om', pct };
        }
        return { date: day.date, om };
      });
  }

  // ─── LGL Bayern ePIN ─────────────────────────────────────────────────────────
  function processLGL(raw, stationId) {
    const result = {};
    let maxToTs = null;
    for (const m of raw.measurements) {
      if (m.location !== stationId) continue;
      const appKey = LGL_MAP[m.polle];
      if (!appKey) continue;
      const maxVal = Math.max(...m.data.map(d => d.value || 0));
      for (const d of m.data) {
        if (d.to != null && (maxToTs == null || d.to > maxToTs)) maxToTs = d.to;
      }
      const thr = LGL_THR[m.polle] || [1, 20, 200, 1000];
      const level = maxVal < thr[0] ? 'none'
        : maxVal < thr[1] ? 'low'
        : maxVal < thr[2] ? 'medium'
        : maxVal < thr[3] ? 'high' : 'very-high';
      const display = maxVal < 1 ? '0' : Math.round(maxVal).toLocaleString('de-DE');
      let pct;
      if (maxVal < thr[0])      pct = Math.round((maxVal / thr[0]) * 33);
      else if (maxVal < thr[1]) pct = Math.round(33 + (maxVal - thr[0]) / (thr[1] - thr[0]) * 33);
      else if (maxVal < thr[2]) pct = Math.round(66 + (maxVal - thr[1]) / (thr[2] - thr[1]) * 17);
      else                      pct = Math.min(Math.round(83 + (maxVal - thr[2]) / (thr[3] - thr[2]) * 17), 100);
      result[appKey] = { level, display, unit: 'K/m³', source: 'lgl', pct };
    }
    const dataDate = maxToTs != null ? new Date(maxToTs * 1000).toISOString() : null;
    return Object.keys(result).length > 0 ? { data: result, dataDate } : null;
  }

  // ─── Merge ───────────────────────────────────────────────────────────────────
  function buildDays(dwdDays, omDays, lglToday = null) {
    const len = Math.max(dwdDays?.length ?? 0, omDays?.length ?? 0, 3);
    return Array.from({ length: len }, (_, i) => {
      const dwd  = dwdDays?.[i]?.dwd;
      const om   = omDays?.[i]?.om;
      const lgl  = i === 0 ? lglToday : null;
      const date = dwdDays?.[i]?.date ?? omDays?.[i]?.date;
      const pollens = {};
      for (const p of POLLEN) {
        if (lgl?.[p.key] != null) {
          pollens[p.key] = lgl[p.key];
        } else if (dwd?.[p.key] != null) {
          const entry = { ...dwd[p.key] };
          if (om?.[p.key]) entry.omDisplay = om[p.key].display;
          pollens[p.key] = entry;
        } else if (om?.[p.key] != null) {
          pollens[p.key] = om[p.key];
        } else {
          pollens[p.key] = null;
        }
      }
      return { date, pollens };
    });
  }

  return {
    LOCATIONS, POLLEN, LGL_MAP, LGL_THR, OM_THR, DWD_MAP, LEVELS, SUMMARY_DE, SNAP_MAX_KM,
    highestLevel, fmtDate, fmtDataTimestamp, haversineKm, nearestLocation,
    parseDwdVal, extractDWDDays, processOM, processLGL, buildDays,
  };
});
