/**
 * Access points behind a NAS (Cycle A, D-044; migration 028): `/api/v1/orgs/{orgId}/access-points`.
 *
 * Third-party portals identify the AP by MAC in the redirect (research §3 "contract gaps"), and a
 * controller / gateway NAS fronts many APs, so an AP is a child record of a NAS:
 *
 *  - `mac`: any common spelling in, canonical `aa:bb:cc:dd:ee:ff` stored; unicast only (no
 *    all-zero, broadcast or group address). GLOBALLY unique among live rows: the portal
 *    resolves an AP before any tenant is known, so a MAC another organization already registered
 *    answers the same generic 409 as a duplicate in this organization (no tenant detail).
 *  - `nas_client_id`: a NAS of this organization (G9 re-check); `site_id` is always copied
 *    from the NAS (composite FK in 028 keeps them equal, ON UPDATE CASCADE follows a NAS that
 *    moves site).
 *  - permissions: the NAS permissions (an AP is part of the NAS registration).
 */
import {
  MAC_ADDRESS_RULE,
  NotFoundError,
  ValidationError,
  canonicalUnicastMac,
} from '@ecloud/shared';
import type { DbTransaction } from '@ecloud/db';
import { z } from 'zod';
import type { AppDeps } from '../context.js';
import { writeAudit } from '../audit.js';
import { requestIsImpersonating } from '../auth/middleware.js';
import { problemResponses } from '../http/common.js';
import { ImpersonationForbiddenError } from '../http/errors.js';
import { defineRoute, type AnyRouteSpec } from '../http/route.js';
import { assertRef, inPlatform } from '../tenant.js';
import { crudRoutes, loose } from './crud.js';

/** Zod field: canonical unicast MAC or a 400 with {@link MAC_ADDRESS_RULE}. */
export const apMac = z
  .string()
  .trim()
  .max(17)
  .refine((v) => canonicalUnicastMac(v) !== null, { message: MAC_ADDRESS_RULE })
  .transform((v) => canonicalUnicastMac(v) as string);

const name = z.string().trim().min(1).max(200).nullable().optional();

export const AccessPointCreate = z.strictObject({
  nas_client_id: z.uuid(),
  mac: apMac,
  name,
  status: z.enum(['active', 'disabled']).optional(),
});

export const AccessPointUpdate = z.strictObject({
  nas_client_id: z.uuid().optional(),
  mac: apMac.optional(),
  name,
  status: z.enum(['active', 'disabled']).optional(),
});

/** The NAS (G9) and its site: an AP always inherits the site of its NAS. */
async function nasSite(trx: DbTransaction, nasClientId: string): Promise<string> {
  const ref = await assertRef(trx, 'nas_clients', nasClientId, 'nas_client');
  if (ref.site_id === null) {
    throw new ValidationError([{ path: 'body.nas_client_id', message: 'NAS has no site' }]);
  }
  return ref.site_id;
}

/** Soft-deletes the access points of a NAS that is being deleted (frees their MACs). */
export async function softDeleteAccessPointsOf(
  trx: DbTransaction,
  nasClientId: string,
): Promise<void> {
  await loose(trx)
    .updateTable('nas_access_points')
    .set({ deleted_at: new Date() })
    .where('nas_client_id', '=', nasClientId)
    .where('deleted_at', 'is', null)
    .execute();
}

export function accessPointRoutes(deps: AppDeps): AnyRouteSpec[] {
  return crudRoutes(deps, {
    table: 'nas_access_points',
    path: '/access-points',
    resource: 'access_point',
    tag: 'nas',
    permissions: {
      read: 'nas:read',
      create: 'nas:create',
      update: 'nas:update',
      delete: 'nas:delete',
    },
    siteMode: 'column',
    softDelete: true,
    createSchema: AccessPointCreate,
    updateSchema: AccessPointUpdate,
    filters: {
      nas_client_id: z.uuid().optional(),
      status: z.enum(['active', 'disabled']).optional(),
    },
    prepareCreate: async (body, { trx }) => ({
      ...body,
      site_id: await nasSite(trx, body.nas_client_id as string),
    }),
    preparePatch: async (body, before, { trx }) => {
      const next: Record<string, unknown> = { ...body };
      const nasChanged =
        typeof body.nas_client_id === 'string' && body.nas_client_id !== before.nas_client_id;
      if (nasChanged) next.site_id = await nasSite(trx, body.nas_client_id as string);
      // A changed identity must be proven again by its NAS (review M1b).
      if (nasChanged || (typeof body.mac === 'string' && body.mac !== before.mac)) {
        next.verified_at = null;
        next.verification_source = null;
      }
      return next;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Platform: release a squatted AP MAC (Cycle A review M1c)
// ---------------------------------------------------------------------------------------------

export const ReleaseAccessPointBody = z.strictObject({
  mac: apMac,
  /** Ticket / justification, kept in the audit row. */
  reason: z.string().trim().min(10).max(500),
});

/**
 * `POST /api/v1/platform/access-points/release`: soft-deletes the live registration of an AP MAC
 * in WHICHEVER organization holds it, so the rightful owner can register it. Tenants only ever
 * see the generic 409; this is the documented support path (platform scope,
 * `organization:update`, refused while impersonating, audited in the owning organization with
 * the reason). The response names the organization only to the platform operator.
 */
export function accessPointPlatformRoutes(deps: AppDeps): AnyRouteSpec[] {
  const release = defineRoute({
    method: 'post',
    path: '/api/v1/platform/access-points/release',
    summary: 'Release an AP MAC registered by any organization (squatting support path)',
    tags: ['platform'],
    auth: 'principal',
    permission: 'organization:update',
    scope: 'platform',
    body: ReleaseAccessPointBody,
    responses: {
      200: {
        description: 'Released',
        schema: z.object({
          mac: z.string(),
          released: z.boolean(),
          organization_id: z.string().nullable(),
        }),
      },
      ...problemResponses,
    },
    handler: async ({ body, req, ctx }) => {
      if (requestIsImpersonating(req)) {
        throw new ImpersonationForbiddenError('organization:update');
      }
      const row = await inPlatform(deps, ctx, 'release access point mac', async (trx) => {
        const ap = await trx
          .updateTable('nas_access_points')
          .set({ deleted_at: new Date() })
          .where('mac', '=', body.mac)
          .where('deleted_at', 'is', null)
          .returning(['id', 'organization_id', 'nas_client_id'])
          .executeTakeFirst();
        if (ap === undefined) return null;
        await writeAudit(trx, ctx, {
          organizationId: ap.organization_id,
          action: 'access_point:release',
          targetType: 'access_point',
          targetId: ap.id,
          before: { mac: body.mac, nas_client_id: ap.nas_client_id },
          after: { released: true, reason: body.reason },
        });
        return ap;
      });
      if (row === null) throw new NotFoundError('access_point', body.mac);
      return {
        status: 200,
        body: { mac: body.mac, released: true, organization_id: row.organization_id },
      };
    },
  });
  return [release];
}
