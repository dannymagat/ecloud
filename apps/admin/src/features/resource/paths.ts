import type { PathFor } from '../../api/client';

/** Organization collection endpoints with a `{ data, next_cursor }` list (checked against the schema). */
export type OrgCollectionPath = Extract<PathFor<'get'>, `/api/v1/orgs/{orgId}/${string}`>;
