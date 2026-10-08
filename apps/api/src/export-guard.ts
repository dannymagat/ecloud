/**
 * Guards shared by the P8-A bulk exports (accounting records, usage reports):
 *  - D-027 default: bulk tenant-data egress is refused while a support administrator
 *    impersonates the organization (403 `impersonation-forbidden`); reads stay allowed;
 *  - API_ARCHITECTURE.md §3.1: 10 exports per hour per principal (fail open on a Redis outage).
 * Q75 (Read Only may not export) is enforced by the permission catalogue: the `read_only`
 * template holds no `*:export` key.
 */
import { EXPORT_LIMIT, hitLimitFailOpen } from './auth/rate-limit.js';
import { TooManyRequestsError } from './http/errors.js';
import type { AppDeps, RequestContext } from './context.js';
import { ImpersonationForbiddenError } from './http/errors.js';

/** D-027 default: no bulk egress while impersonating. Cheap; run it first. */
export function refuseWhileImpersonating(ctx: RequestContext, action: string): void {
  const p = ctx.principal;
  if (p?.kind === 'admin' && p.impersonation !== null) {
    throw new ImpersonationForbiddenError(action);
  }
}

function exportKey(ctx: RequestContext): string {
  const p = ctx.principal;
  const principalId =
    p?.kind === 'admin' ? p.administratorId : p?.kind === 'api_key' ? p.apiKeyId : 'anonymous';
  return `export:${principalId}`;
}

/**
 * Read-only pre-check (P9-A review fix): a caller whose export budget is already spent gets 429
 * before the report query runs, so an over-limit caller cannot make the database do the work.
 * Consumes nothing (the budget is still charged by `consumeExportBudget` after every refusal
 * check); fails open on a store outage like the consuming check.
 */
export async function assertExportBudgetAvailable(
  deps: AppDeps,
  ctx: RequestContext,
): Promise<void> {
  if (deps.config.rateLimitDisabled) return;
  const key = `rl:${exportKey(ctx)}`;
  let used: number;
  try {
    used = Number((await deps.kv.get(key)) ?? '0');
  } catch {
    return;
  }
  if (used >= EXPORT_LIMIT.perHour) {
    const ttl = await deps.kv.ttl(key).catch(() => EXPORT_LIMIT.windowSeconds);
    throw new TooManyRequestsError(ttl > 0 ? ttl : EXPORT_LIMIT.windowSeconds);
  }
}

/**
 * Consumes one unit of the 10/hour export budget. Call it only after every check that can still
 * refuse the request (scope, bounds, row cap), so a refused attempt costs nothing.
 */
export async function consumeExportBudget(deps: AppDeps, ctx: RequestContext): Promise<void> {
  await hitLimitFailOpen(deps, exportKey(ctx), EXPORT_LIMIT.perHour, EXPORT_LIMIT.windowSeconds);
}
