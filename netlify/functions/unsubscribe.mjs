import { getStore } from '@netlify/blobs';
import { endpointKey } from '../lib/util.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const endpoint = body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    return new Response('Invalid payload', { status: 400 });
  }

  await getStore('push-subscriptions').delete(endpointKey(endpoint));

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
