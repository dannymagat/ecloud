/**
 * Shared request/response helpers: id params, cursor pagination, ETag / If-Match.
 */
import type { Request } from 'express';
import { z } from 'zod';
import { PreconditionFailedError } from './errors.js';

export const uuidSchema = z.uuid();

export const OrgParams = z.object({ orgId: z.uuid() });
export const OrgIdParams = z.object({ orgId: z.uuid(), id: z.uuid() });
export const IdParams = z.object({ id: z.uuid() });

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export type Pagination = z.output<typeof PaginationQuery>;

/** Opaque cursor: base64url JSON of the last key. */
export function encodeCursor(value: string | number): string {
  return Buffer.from(JSON.stringify({ k: value }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | number | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { k?: unknown };
    if (typeof parsed.k === 'string' || typeof parsed.k === 'number') return parsed.k;
  } catch {
    // fall through
  }
  return undefined;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/** `rows` was fetched with `limit + 1`; returns the page and the next cursor. */
export function toPage<T>(rows: T[], limit: number, keyOf: (row: T) => string | number): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    next_cursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}

export function etagOf(updatedAt: Date): string {
  return `"${updatedAt.toISOString()}"`;
}

/** Enforces `If-Match` when the client sent one (optimistic concurrency, API_ARCHITECTURE §3.1). */
export function checkIfMatch(req: Request, updatedAt: Date): void {
  const header = req.get('If-Match');
  if (header === undefined || header.trim() === '' || header.trim() === '*') return;
  const candidates = header.split(',').map((v) => v.trim().replace(/^W\//, ''));
  if (!candidates.includes(etagOf(updatedAt))) throw new PreconditionFailedError();
}

/** Generic JSON object schema used for documentation of resource responses. */
export const ResourceSchema = z.looseObject({ id: z.string() });
export const PageSchema = z.object({
  data: z.array(z.looseObject({})),
  next_cursor: z.string().nullable(),
});

export const problemResponses = {
  400: { description: 'Validation failed (application/problem+json)' },
  401: { description: 'Authentication required' },
  403: { description: 'Permission denied' },
  404: { description: 'Not found (also returned for objects of other tenants)' },
} as const;

/** Strips undefined values so PATCH bodies become partial Kysely updates. */
export function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  if (ip === null) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
