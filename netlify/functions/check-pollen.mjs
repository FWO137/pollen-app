import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import PollenLogic from '../../pollen-logic.js';
import { fetchTodayPollens, locationSignature } from '../lib/pollen-helpers.mjs';

const { POLLEN, highestLevel, diffTodayPollens, formatChangeNotification } = PollenLogic;

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

export default async () => {
  const subsStore = getStore('push-subscriptions');
  const snapStore = getStore('pollen-snapshots');

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

    const overall = highestLevel(
      POLLEN.filter((p) => pollens[p.key]).map((p) => pollens[p.key].level),
    );
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
