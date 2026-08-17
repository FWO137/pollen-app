import { getStore } from '@netlify/blobs';
import { locationSignature } from '../lib/pollen-helpers.mjs';

// Read-only: returns the rolling per-day history check-pollen.mjs has been
// collecting for a location, for the client's trend view. History only
// exists for locations that have (or had) an active push subscription —
// that scheduled check is the only thing that ever writes to it — so an
// empty/missing result here just means "not subscribed (yet)", not an error.
export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lon = parseFloat(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response('Invalid lat/lon', { status: 400 });
  }

  const sig = locationSignature({ lat, lon });
  const history = (await getStore('pollen-history').get(sig, { type: 'json' })) ?? [];

  return new Response(JSON.stringify({ history }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
  });
};
