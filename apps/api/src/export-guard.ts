/**
 * Guards shared by the P8-A bulk exports (accounting records, usage reports):
 *  - D-027 default: bulk tenant-data egress is refused while a support administrator
 *    impersonates the organization (403 `impersonation-forbidden`); reads stay allowed;
 *  - API_ARCHITECTURE.md §3.1: 10 exports per hour per principal (fail open on a Redis outage).
 * Q75 (Read Only may not export) is enforced by the permission catalogue: the `read_only`
 * template holds no `*:export` key.
 */
import { EXPORT_LIMIT, hitLimitFailOpen } from './auth/rate-limit.js';
import type { AppDeps, RequestContext } from './context.js';
import { ImpersonationForbiddenError } from './http/errors.js';

/** D-027 default: no bulk egress while impersonating. Cheap; run it first. */
export function refuseWhileImpersonating(ctx: RequestContext, action: string): void {
  const p = ctx.principal;
  if (p?.kind === 'admin' && p.impersonation !== null) {
    throw new ImpersonationForbiddenError(action);
  }
}

/**
 * Consumes one unit of the 10/hour export budget. Call it only after every check that can still
 * refuse the request (scope, bounds, row cap), so a refused attempt costs nothing.
 */
export async function consumeExportBudget(deps: AppDeps, ctx: RequestContext): Promise<void> {
  const p = ctx.principal;
  const principalId =
    p?.kind === 'admin' ? p.administratorId : p?.kind === 'api_key' ? p.apiKeyId : 'anonymous';
  await hitLimitFailOpen(
    deps,
    `export:${principalId}`,
    EXPORT_LIMIT.perHour,
    EXPORT_LIMIT.windowSeconds,
  );
}
