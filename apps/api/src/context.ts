/**
 * Per-request context and the shared dependency bundle.
 */
import type { Db } from '@ecloud/db';
import type { Logger, PermissionScope } from '@ecloud/shared';
import type { ApiConfig } from './config.js';
import type { KvStore } from './kv.js';

export interface AppDeps {
  config: ApiConfig;
  logger: Logger;
  /** RLS-enforced `ecloud_app` connection (DATABASE_URL). */
  db: Db;
  /** BYPASSRLS `ecloud_platform` connection (DATABASE_URL_PLATFORM): authn + platform routes. */
  dbPlatform: Db;
  kv: KvStore;
  /** Clock (tests may freeze it). */
  now?: () => Date;
}

/** One effective role binding of a principal, with the permission keys of its role. */
export interface Grant {
  readonly bindingId: string;
  readonly roleId: string;
  readonly scopeType: PermissionScope;
  readonly organizationId: string | null;
  readonly siteId: string | null;
  readonly permissions: ReadonlySet<string>;
}

export interface Impersonation {
  readonly organizationId: string;
  readonly reason: string;
  readonly expiresAt: Date;
}

export type Principal =
  | {
      readonly kind: 'admin';
      readonly administratorId: string;
      readonly email: string;
      readonly sessionId: string;
      readonly impersonation: Impersonation | null;
      readonly grants: readonly Grant[];
      /** When the session proved a second factor; null otherwise. */
      readonly mfaVerifiedAt: Date | null;
      /**
       * MFA is required (mfa_enforced or a platform binding) but this session has not proved
       * it: `grants` is empty, only enrolment, /auth/me and logout are usable.
       */
      readonly mfaPending: boolean;
    }
  | {
      readonly kind: 'api_key';
      readonly apiKeyId: string;
      readonly createdBy: string | null;
      readonly organizationId: string | null;
      readonly grants: readonly Grant[];
    };

export interface RequestContext {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  principal: Principal | null;
  /** How the principal authenticated (CSRF applies to cookie sessions only). */
  authMethod: 'cookie' | 'api_key' | null;
  /** Memoised authorization decisions for this request. */
  readonly decisions: Map<string, boolean>;
  /** Set once a mutation handler wrote its audit row. */
  audited: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx: RequestContext;
  }
}
