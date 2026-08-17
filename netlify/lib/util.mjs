import { createHash } from 'node:crypto';

// Push subscription endpoints are long, unique URLs — hash them down to a
// stable, filesystem/blob-key-safe identifier instead of storing the raw
// URL as a key.
export function endpointKey(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}
