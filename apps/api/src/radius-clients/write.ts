/**
 * Atomic replacement of the rendered clients file. The new content goes to a dot-file in the
 * same directory (FreeRADIUS `$INCLUDE dir/` skips names starting with "."), created exclusively
 * with mode 0640, fsync'ed, then renamed over the target and the directory fsync'ed. On any
 * failure the temp file is removed and the previous file stays untouched; FreeRADIUS never sees
 * a half-written or empty file.
 *
 * Group readability: the file inherits the process group (pilot: gid 101 = `freerad` via
 * `user: '1000:101'`), so the FreeRADIUS container reads it through its read-only mount.
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const CLIENTS_FILE_MODE = 0o640;

export interface WriteResult {
  /** False when the target already had exactly this content (nothing written). */
  changed: boolean;
}

async function currentContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeClientsFileAtomic(path: string, content: string): Promise<WriteResult> {
  if (content.trim() === '') throw new Error('refusing to write an empty clients file');
  if ((await currentContent(path)) === content) return { changed: false };

  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    CLIENTS_FILE_MODE,
  );
  let renamed = false;
  try {
    try {
      await handle.chmod(CLIENTS_FILE_MODE); // the umask may have narrowed the create mode
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
  const dirHandle = await open(dir, constants.O_RDONLY).catch(() => null);
  if (dirHandle !== null) {
    await dirHandle.sync().catch(() => undefined);
    await dirHandle.close();
  }
  return { changed: true };
}
