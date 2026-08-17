import PollenLogic from '../../pollen-logic.js';

const { POLLEN, extractDWDDays, processOM, processLGL, buildDays } = PollenLogic;

const DWD_URL = 'https://opendata.dwd.de/climate_environment/health/alerts/s31fg.json';
const LGL_URL = 'https://epin.lgl.bayern.de/api/measurements';

// The client fetches DWD/LGL through Netlify redirects to dodge browser
// CORS; a server-side function has no such restriction and can hit the
// real APIs directly.

// "Today" per the real German calendar date, independent of whatever
// timezone this function happens to execute in (Netlify's Node runtime is
// typically UTC) — same reasoning as the DWD-staleness fix in the client.
function todayBerlin() {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m, d] = ymd.split('-').map(Number);
  return { dateStr: ymd, referenceDate: new Date(y, m - 1, d, 12) };
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

// Fetches + merges today's pollen data for one location, the same way the
// client's loadData() does, minus anything UI-specific (caching, timeouts
// tuned for a mobile connection, etc. — a scheduled function can just await
// plainly since nothing is blocking a user's screen).
export async function fetchTodayPollens(location) {
  const { dateStr, referenceDate } = todayBerlin();
  const { lat, lon, country, dwd, lgl } = location;

  const omVars = POLLEN.filter((p) => p.om).map((p) => p.om).join(',');
  const omUrl = `https://air-quality-api.open-meteo.com/v1/air-quality`
    + `?latitude=${lat}&longitude=${lon}&hourly=${omVars}&timezone=auto&forecast_days=3`;

  const omPromise = fetchJson(omUrl).then(processOM).catch(() => null);

  const dwdPromise = (country === 'DE' && dwd != null)
    ? fetchJson(DWD_URL).then((raw) => extractDWDDays(raw, dwd, referenceDate)).catch(() => null)
    : Promise.resolve(null);

  const lglPromise = lgl
    ? fetchJson(LGL_URL).then((raw) => processLGL(raw, lgl)).catch(() => null)
    : Promise.resolve(null);

  const [omResult, dwdResult, lglResult] = await Promise.all([omPromise, dwdPromise, lglPromise]);

  const days = buildDays(dwdResult?.days ?? null, omResult, lglResult?.data ?? null);
  const today = days.find((d) => d.date === dateStr) ?? days[0];
  return { dateStr, pollens: today.pollens };
}

export function locationSignature(loc) {
  return `${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
}
