import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { endpointKey } from '../lib/util.mjs';

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { subscription, location, locationName } = body ?? {};
  if (
    !subscription?.endpoint
    || !subscription?.keys?.p256dh
    || !subscription?.keys?.auth
    || typeof location?.lat !== 'number'
    || typeof location?.lon !== 'number'
  ) {
    return new Response('Invalid subscription payload', { status: 400 });
  }

  const store = getStore('push-subscriptions');
  await store.setJSON(endpointKey(subscription.endpoint), {
    subscription,
    location: {
      lat: location.lat,
      lon: location.lon,
      country: location.country ?? null,
      dwd: location.dwd ?? null,
      lgl: location.lgl ?? null,
    },
    locationName: typeof locationName === 'string' ? locationName.slice(0, 80) : null,
    createdAt: new Date().toISOString(),
  });

  // Immediate confirmation push — doubles as an end-to-end pipeline check
  // (VAPID + subscription + service worker) the user can verify right away
  // instead of waiting up to 2 hours for a real data change to trigger one.
  try {
    await webpush.sendNotification(subscription, JSON.stringify({
      title: 'Benachrichtigungen aktiviert',
      body: locationName
        ? `Du bekommst ab jetzt eine Nachricht, wenn sich die Pollenwerte für ${locationName} ändern.`
        : 'Du bekommst ab jetzt eine Nachricht, wenn sich deine Pollenwerte ändern.',
    }));
  } catch (err) {
    console.error('confirmation push failed', err?.statusCode, err?.body || err);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
