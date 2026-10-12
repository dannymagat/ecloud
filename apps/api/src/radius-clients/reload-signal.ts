/**
 * NAS hot-reload signal.
 *
 * When a NAS client record is created, updated, deleted, or its RADIUS secret is rotated,
 * the API sets a Redis key `radius:clients:reload_pending` with a short TTL (5 min).
 *
 * A host-side watcher (`infra/vps-local/scripts/radius-reload-watch.sh`) polls this key every
 * 30 s and, when it appears, runs `reload-radius.sh` to re-render `clients.conf` and restart
 * FreeRADIUS.  The key is deleted after a successful reload so the watcher does not re-fire.
 *
 * Why Redis and not a direct API→container exec?
 *   - The API container has no Docker socket access.
 *   - FreeRADIUS restart requires `sudo` on the VPS host (out of the container network).
 *   - The Redis-key indirection keeps the trust boundary intact: the API only writes a flag;
 *     the host-side watcher decides when and how to reload.
 *
 * Why not PostgreSQL LISTEN/NOTIFY?
 *   - The watcher is a simple bash loop; polling Redis with `redis-cli` is simpler than
 *     subscribing to pg_notify from a shell script.
 */

import type { KvStore } from '../kv.js';

/** Key written when a NAS reload is pending.  TTL: 5 min (safety: clears stale signals). */
export const RADIUS_RELOAD_PENDING_KEY = 'radius:clients:reload_pending';
const RADIUS_RELOAD_TTL_S = 300;

/**
 * Signal that FreeRADIUS clients.conf needs to be re-rendered and FreeRADIUS restarted.
 * Safe to call multiple times; subsequent calls extend the TTL but don't cause double-reload.
 */
export async function signalRadiusClientsReload(kv: KvStore, reason: string): Promise<void> {
  await kv.set(
    RADIUS_RELOAD_PENDING_KEY,
    JSON.stringify({ reason, ts: new Date().toISOString() }),
    RADIUS_RELOAD_TTL_S,
  );
}
