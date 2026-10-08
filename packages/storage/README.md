# @ecloud/storage

Object storage abstraction for ECLOUD (D-026). The pilot may keep non-critical assets (branding,
development files) on the local filesystem; production uses external S3-compatible storage. The
switch is configuration only (`STORAGE_DRIVER`) — no business-logic change.

## Usage

```ts
import { loadConfig } from '@ecloud/shared';
import { createStorage, forTenant } from '@ecloud/storage';

const storage = createStorage(loadConfig().storage); // once per process
const tenant = forTenant(storage, orgId); // orgId from the authenticated tenant context

const meta = await tenant.put('branding', assetId, bytesOrStream, { contentType: 'image/png' });
// meta: { key, size, contentType, sha256, lastModified }
const object = await tenant.get('branding', assetId); // object.body is a Readable
await tenant.delete('branding', assetId);
```

Never import a driver class directly; `createStorage` is the only place drivers are created.

## Keys and tenant isolation

Keys are `org/{organizationId}/{purpose}/{id}` (`buildObjectKey`, `parseObjectKey`):

- `organizationId`: lower-case UUID;
- `purpose`: a registered purpose (`STORAGE_PURPOSES`);
- `id`: 1-128 chars of `[a-z0-9._-]` (lower-case only, so keys cannot alias on case-insensitive
  filesystems), starting with a letter/digit, no `..`.

Absolute paths, `..`, extra/empty segments, backslashes, null bytes and control characters are
rejected with `InvalidStorageKeyError` on **every** driver call, even for keys built elsewhere.
`list` accepts only `org/{organizationId}/` or `org/{organizationId}/{purpose}/`. `forTenant`
binds one organization; `assertOwnKey(key)` / `assertKeyInTenant(key, orgId)` reject keys of
another tenant (e.g. a key read from a DB row).

## Purposes

| Purpose    | Content types                          | Max size |
| ---------- | -------------------------------------- | -------- |
| `branding` | `image/png`, `image/jpeg`, `image/webp` | 5 MiB    |

The declared type is normalised and must be allow-listed **and** match the file's magic bytes
(`ContentTypeNotAllowedError`, 415). SVG is rejected: it can carry script and no sanitiser exists;
allowing it needs an explicit later decision. Size is enforced while reading the body
(`ObjectTooLargeError`, 413); callers may pass a tighter `maxBytes`, never a looser one. Bodies are
buffered up to the limit so they can be sniffed and hashed (SHA-256) before anything is written.

## Interface

`ObjectStorage`: `put`, `get` (stream), `head` (`null` when missing), `delete` (idempotent),
`list(prefix, { limit })`, `getSignedReadUrl(key, { expiresInSeconds })` (1-3600 s, default 300),
`checkHealth()`, `close()`, plus `driver` and `capabilities.signedReadUrls`.

Errors extend `AppError` (RFC 9457): `InvalidStorageKeyError` 400, `ObjectNotFoundError` 404,
`ObjectTooLargeError` 413, `ContentTypeNotAllowedError` 415, `StorageOperationUnsupportedError`
501, `StorageBackendError` 503 (cause kept, never shown; no endpoint/credential details).

## Drivers

| Driver  | Config                                                                                                   | Signed URLs                  |
| ------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `local` | `STORAGE_LOCAL_PATH`                                                                                     | unsupported (throws 501)     |
| `s3`    | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | yes (SigV4 presigned `GET`)  |

**local** — layout `objects/<key>/<version>` (immutable content, one file per write),
`meta/<key>.json` (`version`, content type, size, SHA-256), `tmp/`. A write stores a new content
version (temp file, fsync, `rename`), then commits by renaming the metadata into place, then
prunes superseded versions. If the metadata commit fails, the old metadata still references the
old, untouched content, so new content is never paired with old metadata (tested by forcing the
metadata rename to fail). Sizes come from the content file. Concurrent writes to the same key are
last-writer-wins and a reader racing a prune can see a transient not-found. Leftover `tmp/*.tmp`
files older than 1 hour (`tmpMaxAgeMs`) are swept at first use and on `checkHealth()`.
Directories are 0700, files 0600. Every path component below the root is `lstat`-checked (no
symlinks, must be a directory) and files are opened with `O_NOFOLLOW`. The root itself may be an
operator-chosen symlink.

**The storage root must be owned exclusively by the service user (mode 0700).** There is an
unavoidable window between the `lstat` checks and the subsequent `open`/`rename` (TOCTOU); it can
only be exploited by someone who can already write inside the root. Never point
`STORAGE_LOCAL_PATH` at a shared or world-writable directory. In production the local driver is
refused unless `STORAGE_LOCAL_ALLOW_PRODUCTION=true` (D-026: non-critical assets only, never the
only copy of anything that must survive the VPS).

**s3** — AWS SDK v3 against any S3-compatible endpoint. Credentials come only from config (env /
injected secrets); if empty, the SDK default provider chain is used. Checksums are
`WHEN_REQUIRED` for compatibility with non-AWS services. `x-amz-meta-sha256` stores the hash.
The endpoint is operator configuration, never user input (no SSRF surface); in production it
must be `https://` (enforced by `loadConfig`). `NoSuchBucket` and other bucket-level 404s are
backend errors (503), never "object not found" (a HEAD 404 is confirmed with `HeadBucket`).
`getSignedReadUrl` reads the stored metadata first and pins `response-content-type` to the
stored type and `response-content-disposition` to `inline; filename="<id>"`.

## Serving objects (rule for future endpoints)

Any endpoint that serves stored bytes (e.g. portal `/a/{assetId}`) must:

- set `Content-Type` from the stored metadata (never from the request or file name);
- set `X-Content-Type-Options: nosniff`;
- for S3, hand out only URLs from `getSignedReadUrl` (which pins type and disposition);
- cap the HTTP request body itself before calling `put` (the storage limit is not an HTTP limit).

## Tests (what has actually been verified)

- `npm test` — key/purpose/upload unit tests, the shared contract (`src/storage.contract.ts`)
  against the **local** driver, local-only tests (permissions, version commit failure path, temp
  sweep, symlink escapes), and S3 unit tests with a stubbed client (error mapping, signed URL
  parameters).
- S3 contract: set `ECLOUD_TEST_S3_ENDPOINT`, `ECLOUD_TEST_S3_ACCESS_KEY_ID`,
  `ECLOUD_TEST_S3_SECRET_ACCESS_KEY` (optional `ECLOUD_TEST_S3_BUCKET`, default `ecloud-test`,
  created if missing; `ECLOUD_TEST_S3_REGION`). Skipped otherwise.
- The S3 contract has been run **only against RustFS** (`rustfs/rustfs:latest`, throwaway container
  on 127.0.0.1, 2026-10-08). AWS S3, Cloudflare R2, Backblaze B2, Wasabi and other providers are
  **untested**; run the contract against the chosen provider before production use.
