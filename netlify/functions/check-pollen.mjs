import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import PollenLogic from '../../pollen-logic.js';
import { fetchTodayPollens, locationSignature } from '../lib/pollen-helpers.mjs';

const { overallLevel, diffTodayPollens, formatChangeNotification } = PollenLogic;

// netlify/functions/history.mjs only ever shows the client the last 7 days
// (the trend view), but we keep a bit more than that here as a cushion —
// e.g. in case a scheduled run is ever skipped right at a day boundary.
const HISTORY_DAYS_KEPT = 14;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

// Upserts today's entry into this location's rolling history (one entry
// per calendar day — updated in place on every run until the day rolls
// over, so the trend view reflects the latest data even mid-day), trimmed
// to HISTORY_DAYS_KEPT oldest-to-newest entries.
async function recordHistory(historyStore, sig, dateStr, overall, pollens) {
  const history = (await historyStore.get(sig, { type: 'json' })) ?? [];
  const entry = { date: dateStr, overall, pollens };
  const idx = history.findIndex((h) => h.date === dateStr);
  if (idx >= 0) history[idx] = entry; else history.push(entry);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await historyStore.setJSON(sig, history.slice(-HISTORY_DAYS_KEPT));
}

export default async () => {
  const subsStore = getStore('push-subscriptions');
  const snapStore = getStore('pollen-snapshots');
  const historyStore = getStore('pollen-history');

  const { blobs } = await subsStore.list();
  if (blobs.length === 0) return new Response('no subscriptions', { status: 200 });

  // Group subscriptions by location so a shared spot (same lat/lon rounded
  // to ~1km) only triggers one set of API calls, not one per subscriber.
  const byLocation = new Map();
  for (const { key } of blobs) {
    const record = await subsStore.get(key, { type: 'json' });
    if (!record?.subscription || !record?.location) continue;
    const sig = locationSignature(record.location);
    if (!byLocation.has(sig)) {
      byLocation.set(sig, { location: record.location, locationName: record.locationName, subs: [] });
    }
    byLocation.get(sig).subs.push({ key, subscription: record.subscription });
  }

  const results = [];

  for (const { location, locationName, subs } of byLocation.values()) {
    const sig = locationSignature(location);
    let dateStr, pollens;
    try {
      ({ dateStr, pollens } = await fetchTodayPollens(location));
    } catch (err) {
      console.error('fetchTodayPollens failed for', sig, err);
      results.push({ sig, status: 'fetch-failed' });
      continue;
    }

    const overall = overallLevel(pollens);

    // History is recorded regardless of whether anything changed or this
    // is the first check ever — it's the trend view's raw material, not
    // part of the change-notification decision below.
    await recordHistory(historyStore, sig, dateStr, overall, pollens);

    const snapshot = await snapStore.get(sig, { type: 'json' });

    if (!snapshot || snapshot.dateStr !== dateStr) {
      // First check ever for this location, or the calendar day rolled
      // over since the last one — establish a fresh baseline instead of
      // diffing across two different days (which would flag everything
      // as "changed" and spam a notification for no real reason).
      await snapStore.setJSON(sig, { dateStr, pollens });
      results.push({ sig, status: 'baseline-set' });
      continue;
    }

    const changes = diffTodayPollens(snapshot.pollens, pollens);
    if (changes.length === 0) {
      results.push({ sig, status: 'no-change' });
      continue;
    }

    const { title, body } = formatChangeNotification(changes, overall, locationName);
    const payload = JSON.stringify({ title, body });

    await Promise.all(subs.map(async ({ key, subscription }) => {
      try {
        await webpush.sendNotification(subscription, payload);
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          // Subscription expired/was revoked client-side — stop retrying it.
          await subsStore.delete(key);
        } else {
          console.error('push send failed for', key, err?.statusCode, err?.body || err);
        }
      }
    }));

    await snapStore.setJSON(sig, { dateStr, pollens });
    results.push({ sig, status: 'notified', changes: changes.length });
  }

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { schedule: '0 */2 * * *' };
