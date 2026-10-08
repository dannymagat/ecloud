import { ContentTypeNotAllowedError } from './errors.js';

/** Policy for one kind of stored object: what may be uploaded and how large it may be. */
export interface StoragePurposePolicy {
  /** Lower-case MIME types (no parameters) accepted for this purpose. */
  readonly allowedContentTypes: readonly string[];
  /** Hard upper bound in bytes; callers may only tighten it. */
  readonly maxBytes: number;
}

const MIB = 1024 * 1024;

/**
 * Registry of storage purposes. A purpose is the third key segment
 * (`org/{organizationId}/{purpose}/{id}`).
 *
 * - `branding`: portal logos/backgrounds (API_ARCHITECTURE "multipart ... branding assets
 *   (≤ 5 MB, type-sniffed)"). PNG, JPEG and WebP only. SVG is deliberately rejected: it can
 *   carry script and no SVG sanitiser is in place; allowing it needs an explicit later decision.
 */
export const STORAGE_PURPOSES = Object.freeze({
  branding: Object.freeze({
    allowedContentTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
    maxBytes: 5 * MIB,
  }),
} satisfies Record<string, StoragePurposePolicy>);

export type StoragePurpose = keyof typeof STORAGE_PURPOSES;

export function isStoragePurpose(value: unknown): value is StoragePurpose {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STORAGE_PURPOSES, value);
}

export function purposePolicy(purpose: StoragePurpose): StoragePurposePolicy {
  return STORAGE_PURPOSES[purpose];
}

/** `Image/PNG; charset=x` -> `image/png`. Returns '' for an empty or malformed value. */
export function normalizeContentType(contentType: string): string {
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : '';
}

/**
 * Validates the declared content type against the purpose allow-list and returns the
 * normalised type. Throws `ContentTypeNotAllowedError`.
 */
export function assertContentTypeAllowed(purpose: StoragePurpose, contentType: string): string {
  const normalized = normalizeContentType(contentType);
  if (normalized === '') {
    throw new ContentTypeNotAllowedError('content type is missing or malformed');
  }
  if (!purposePolicy(purpose).allowedContentTypes.includes(normalized)) {
    throw new ContentTypeNotAllowedError(
      `content type ${normalized} is not allowed for purpose ${purpose}`,
    );
  }
  return normalized;
}

/** Effective size limit: the purpose limit, optionally tightened (never loosened) by the caller. */
export function effectiveMaxBytes(purpose: StoragePurpose, requested?: number): number {
  const limit = purposePolicy(purpose).maxBytes;
  if (requested === undefined) return limit;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError('maxBytes must be a non-negative integer');
  }
  return Math.min(limit, requested);
}

type Sniffer = (bytes: Uint8Array) => boolean;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Magic-byte checks for the types we accept. A type without a sniffer is never accepted. */
const SNIFFERS: Readonly<Record<string, Sniffer>> = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/webp': (b) => startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8),
};

/**
 * Checks that the bytes match the declared (normalised, allow-listed) content type, so a
 * client cannot store e.g. HTML or SVG labelled `image/png`. Throws `ContentTypeNotAllowedError`.
 */
export function assertContentMatchesType(contentType: string, bytes: Uint8Array): void {
  const sniff = SNIFFERS[contentType];
  if (sniff === undefined) {
    throw new ContentTypeNotAllowedError(`no content check is defined for ${contentType}`);
  }
  if (!sniff(bytes)) {
    throw new ContentTypeNotAllowedError(`content does not match declared type ${contentType}`);
  }
}
