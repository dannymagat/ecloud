import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ObjectNotFoundError,
  StorageBackendError,
  StorageOperationUnsupportedError,
} from './errors.js';
import { assertObjectId, parseObjectKey, parseTenantPrefix, type ObjectKey } from './keys.js';
import { STORAGE_PURPOSES, type StoragePurpose } from './purposes.js';
import {
  resolveListLimit,
  type ListObjectsOptions,
  type ObjectBody,
  type ObjectMetadata,
  type ObjectStorage,
  type ObjectSummary,
  type PutObjectOptions,
  type StoredObject,
} from './types.js';
import { prepareUpload } from './upload.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const META_SUFFIX = '.json';
const TMP_SUFFIX = '.tmp';
const VERSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Default age after which leftover `tmp/*.tmp` files (crashed writes) are deleted. */
export const DEFAULT_TMP_MAX_AGE_MS = 60 * 60 * 1000;

type Area = 'objects' | 'meta' | 'tmp';

/** `meta/<key>.json`. It names the content version it describes, so the two always match. */
interface MetaRecord {
  version: string;
  contentType: string;
  size: number;
  sha256: string;
  lastModified: string;
}

export interface LocalStorageOptions {
  /**
   * Root directory (STORAGE_LOCAL_PATH). Relative paths resolve against the process cwd. It must
   * be owned exclusively by the service user (0700): see the TOCTOU note on the class.
   */
  rootPath: string;
  /** Leftover temp files older than this are swept at first use and on `checkHealth()`. */
  tmpMaxAgeMs?: number;
}

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;

class SymlinkEscapeError extends Error {
  constructor() {
    super('storage path component is not a plain directory/file (symlink or special file)');
    this.name = 'SymlinkEscapeError';
  }
}

/**
 * Local filesystem driver (D-026: pilot/dev, non-critical assets only; never the sole copy of
 * anything that must survive the VPS).
 *
 * Layout under the root:
 * - `objects/<key>/<version>` — immutable content files, one per write (`version` = UUID v4);
 * - `meta/<key>.json` — `{version, contentType, size, sha256, lastModified}`;
 * - `tmp/` — in-flight writes (`*.tmp`).
 *
 * A write stores a new content version (temp file, fsync, rename), then commits by atomically
 * renaming the metadata into place, then prunes superseded versions. The metadata rename is the
 * commit point: if it fails, the old metadata still points at the old (untouched) content, so a
 * reader never pairs new content with old metadata. Sizes are taken from the content file.
 * Concurrent writes to the same key are last-writer-wins; a reader racing a prune may see a
 * transient not-found.
 *
 * Directories are 0700, files 0600. Every path component below the root is `lstat`-checked and
 * must be a real directory, and files are opened with `O_NOFOLLOW`, so a symlink planted in the
 * tree cannot redirect reads or writes. There is an unavoidable window between those checks and
 * the operation (TOCTOU); it is only exploitable by someone who can already write inside the
 * root, which is why the root must be exclusively owned by the service user (0700).
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  readonly capabilities = { signedReadUrls: false } as const;

  private readonly configuredRoot: string;
  private readonly tmpMaxAgeMs: number;
  private rootPromise: Promise<string> | undefined;

  constructor(options: LocalStorageOptions) {
    this.configuredRoot = resolve(options.rootPath);
    this.tmpMaxAgeMs = options.tmpMaxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
  }

  async put(rawKey: string, body: ObjectBody, options: PutObjectOptions): Promise<ObjectMetadata> {
    const upload = await prepareUpload(rawKey, body, options);
    const { dirSegments, fileName } = splitKey(upload.key);
    const lastModified = new Date();
    const meta: MetaRecord = {
      version: randomUUID(),
      contentType: upload.contentType,
      size: upload.bytes.byteLength,
      sha256: upload.sha256,
      lastModified: lastModified.toISOString(),
    };
    await this.guard('put', async () => {
      const versionsDir = await this.dir('objects', [...dirSegments, fileName], true);
      const metaDir = await this.dir('meta', dirSegments, true);
      const tmpDir = await this.dir('tmp', [], true);
      if (versionsDir === null || metaDir === null || tmpDir === null) {
        throw new Error('storage directories could not be created');
      }
      const contentPath = join(versionsDir, meta.version);
      await atomicWrite(tmpDir, contentPath, upload.bytes);
      try {
        // Commit point.
        await atomicWrite(
          tmpDir,
          join(metaDir, fileName + META_SUFFIX),
          Buffer.from(JSON.stringify(meta)),
        );
      } catch (error) {
        await unlinkIfExists(contentPath).catch(() => undefined);
        throw error;
      }
      await this.pruneVersions(dirSegments, fileName).catch(() => undefined);
    });
    return {
      key: upload.key,
      size: meta.size,
      contentType: meta.contentType,
      sha256: meta.sha256,
      lastModified,
    };
  }

  async get(rawKey: string): Promise<StoredObject> {
    const { key } = parseObjectKey(rawKey);
    const { dirSegments, fileName } = splitKey(key);
    return this.guard('get', async () => {
      const meta = await this.readMeta(dirSegments, fileName);
      const versionsDir = await this.dir('objects', [...dirSegments, fileName], false);
      if (meta === null || versionsDir === null) throw new ObjectNotFoundError(key);
      let handle: FileHandle;
      try {
        handle = await open(join(versionsDir, meta.version), READ_FLAGS);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) throw new ObjectNotFoundError(key);
        if (isErrno(error, 'ELOOP')) throw new SymlinkEscapeError();
        throw error;
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new SymlinkEscapeError();
        return {
          key,
          size: stats.size,
          contentType: meta.contentType,
          sha256: meta.sha256,
          lastModified: new Date(meta.lastModified),
          body: handle.createReadStream({ autoClose: true }),
        };
      } catch (error) {
        await handle.close();
        throw error;
      }
    });
  }

  async head(rawKey: string): Promise<ObjectMetadata | null> {
    const { key } = parseObjectKey(rawKey);
    const { dirSegments, fileName } = splitKey(key);
    return this.guard('head', async () => {
      const meta = await this.readMeta(dirSegments, fileName);
      const versionsDir = await this.dir('objects', [...dirSegments, fileName], false);
      if (meta === null || versionsDir === null) return null;
      const stats = await lstatOrNull(join(versionsDir, meta.version));
      if (stats === null) return null;
      if (!stats.isFile()) throw new SymlinkEscapeError();
      return {
        key,
        size: stats.size,
        contentType: meta.contentType,
        sha256: meta.sha256,
        lastModified: new Date(meta.lastModified),
      };
    });
  }

  async delete(rawKey: string): Promise<void> {
    const { key } = parseObjectKey(rawKey);
    const { dirSegments, fileName } = splitKey(key);
    await this.guard('delete', async () => {
      // Metadata first: the object disappears from head/get/list before its content is removed.
      const metaDir = await this.dir('meta', dirSegments, false);
      if (metaDir !== null) await unlinkIfExists(join(metaDir, fileName + META_SUFFIX));
      // `dir` verified every component is a real directory; rm never follows symlinks inside it.
      const versionsDir = await this.dir('objects', [...dirSegments, fileName], false);
      if (versionsDir !== null) await rm(versionsDir, { recursive: true, force: true });
    });
  }

  async list(rawPrefix: string, options?: ListObjectsOptions): Promise<ObjectSummary[]> {
    const { organizationId, purpose } = parseTenantPrefix(rawPrefix);
    const limit = resolveListLimit(options);
    const purposes: StoragePurpose[] =
      purpose === undefined ? (Object.keys(STORAGE_PURPOSES) as StoragePurpose[]) : [purpose];
    return this.guard('list', async () => {
      const results: ObjectSummary[] = [];
      for (const p of purposes) {
        const segments = ['org', organizationId, p];
        const metaDir = await this.dir('meta', segments, false);
        if (metaDir === null) continue;
        for (const entry of await readdir(metaDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(META_SUFFIX)) continue;
          const id = entry.name.slice(0, -META_SUFFIX.length);
          try {
            assertObjectId(id);
          } catch {
            continue;
          }
          const meta = await this.readMeta(segments, id);
          const versionsDir = await this.dir('objects', [...segments, id], false);
          if (meta === null || versionsDir === null) continue;
          const stats = await lstatOrNull(join(versionsDir, meta.version));
          if (stats === null || !stats.isFile()) continue;
          results.push({
            key: `org/${organizationId}/${p}/${id}` as ObjectKey,
            size: stats.size,
            lastModified: new Date(meta.lastModified),
          });
        }
      }
      results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return results.slice(0, limit);
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async: validation errors reject
  async getSignedReadUrl(rawKey: string): Promise<string> {
    parseObjectKey(rawKey);
    throw new StorageOperationUnsupportedError('getSignedReadUrl', this.driver);
  }

  /** Probes write access to `tmp/` and sweeps stale temp files left by crashed writes. */
  async checkHealth(): Promise<void> {
    await this.guard('health check', async () => {
      const tmpDir = await this.dir('tmp', [], true);
      if (tmpDir === null) throw new Error('tmp directory unavailable');
      await this.sweepTmp(tmpDir);
      const probe = join(tmpDir, `health-${randomUUID()}${TMP_SUFFIX}`);
      const handle = await open(probe, 'wx', FILE_MODE);
      await handle.close();
      await unlink(probe);
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Runs a filesystem operation, converting unexpected failures to `StorageBackendError`. */
  private async guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw error;
      throw new StorageBackendError(operation, { cause: error });
    }
  }

  private root(): Promise<string> {
    this.rootPromise ??= (async () => {
      await mkdir(this.configuredRoot, { recursive: true, mode: DIR_MODE });
      // The root itself may be an operator-chosen symlink; everything below it may not.
      const root = await realpath(this.configuredRoot);
      const tmpDir = join(root, 'tmp');
      const stats = await lstatOrNull(tmpDir);
      if (stats?.isDirectory() === true && !stats.isSymbolicLink()) {
        await this.sweepTmp(tmpDir).catch(() => undefined);
      }
      return root;
    })().catch((error: unknown) => {
      this.rootPromise = undefined;
      throw error;
    });
    return this.rootPromise;
  }

  /** Deletes regular `*.tmp` files in `tmpDir` older than `tmpMaxAgeMs`. */
  private async sweepTmp(tmpDir: string): Promise<void> {
    const cutoff = Date.now() - this.tmpMaxAgeMs;
    for (const entry of await readdir(tmpDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(TMP_SUFFIX)) continue;
      const path = join(tmpDir, entry.name);
      const stats = await lstatOrNull(path);
      if (stats === null || !stats.isFile() || stats.mtimeMs >= cutoff) continue;
      await unlinkIfExists(path);
    }
  }

  /** Removes content versions other than the one the current metadata references. */
  private async pruneVersions(dirSegments: readonly string[], fileName: string): Promise<void> {
    const meta = await this.readMeta(dirSegments, fileName);
    const versionsDir = await this.dir('objects', [...dirSegments, fileName], false);
    if (meta === null || versionsDir === null) return;
    for (const entry of await readdir(versionsDir, { withFileTypes: true })) {
      if (entry.name === meta.version || !VERSION_RE.test(entry.name)) continue;
      await unlinkIfExists(join(versionsDir, entry.name));
    }
  }

  /**
   * Resolves `<root>/<area>/<segments...>`, checking each component is a real directory
   * (not a symlink). Creates missing components (0700) when `create`; otherwise returns
   * `null` if any is missing.
   */
  private async dir(
    area: Area,
    segments: readonly string[],
    create: boolean,
  ): Promise<string | null> {
    let current = await this.root();
    for (const segment of [area, ...segments]) {
      current = join(current, segment);
      let stats = await lstatOrNull(current);
      if (stats === null) {
        if (!create) return null;
        try {
          await mkdir(current, { mode: DIR_MODE });
        } catch (error) {
          if (!isErrno(error, 'EEXIST')) throw error;
        }
        stats = await lstat(current);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new SymlinkEscapeError();
    }
    return current;
  }

  private async readMeta(
    dirSegments: readonly string[],
    fileName: string,
  ): Promise<MetaRecord | null> {
    const metaDir = await this.dir('meta', dirSegments, false);
    if (metaDir === null) return null;
    let handle: FileHandle;
    try {
      handle = await open(join(metaDir, fileName + META_SUFFIX), READ_FLAGS);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      if (isErrno(error, 'ELOOP')) throw new SymlinkEscapeError();
      throw error;
    }
    try {
      const parsed = JSON.parse(await handle.readFile('utf8')) as Partial<MetaRecord>;
      if (
        typeof parsed.version !== 'string' ||
        !VERSION_RE.test(parsed.version) ||
        typeof parsed.contentType !== 'string' ||
        typeof parsed.lastModified !== 'string' ||
        typeof parsed.sha256 !== 'string' ||
        typeof parsed.size !== 'number'
      ) {
        throw new Error('corrupt metadata record');
      }
      return {
        version: parsed.version,
        contentType: parsed.contentType,
        size: parsed.size,
        sha256: parsed.sha256,
        lastModified: parsed.lastModified,
      };
    } finally {
      await handle.close();
    }
  }
}

function splitKey(key: ObjectKey): { dirSegments: string[]; fileName: string } {
  const segments = key.split('/');
  const fileName = segments.pop();
  if (fileName === undefined) throw new Error('unreachable: validated key has segments');
  return { dirSegments: segments, fileName };
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  const stats = await lstatOrNull(path);
  if (stats === null) return;
  if (stats.isDirectory()) throw new SymlinkEscapeError();
  // unlink removes a symlink itself, never its target.
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/** Writes `bytes` to a fresh 0600 temp file in `tmpDir`, fsyncs, then renames onto `target`. */
async function atomicWrite(tmpDir: string, target: string, bytes: Uint8Array): Promise<void> {
  const tmpPath = join(tmpDir, `${randomUUID()}${TMP_SUFFIX}`);
  const handle = await open(tmpPath, 'wx', FILE_MODE);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // rename(2) replaces a pre-existing symlink at `target` rather than following it.
    await rename(tmpPath, target);
  } catch (error) {
    await unlinkIfExists(tmpPath).catch(() => undefined);
    throw error;
  }
}
