import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isNodeError } from '../errors.js';

/**
 * Replaces a file so that readers see either the old contents or the new contents, never a mixture.
 * The temporary file sits next to the target because rename is only atomic within a filesystem.
 */
export async function writeFileAtomic(file: string, contents: string, mode = 0o600): Promise<void> {
  const target = followSymlink(file);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const descriptor = openSync(temporary, 'wx', mode);
    try {
      writeSync(descriptor, contents);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    await renameWithRetry(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Keeps a symlinked config (for example one managed by a dotfiles repository) a symlink. */
function followSymlink(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

/** Windows refuses to replace a file another process has open for a moment. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const transient =
        isNodeError(error) && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? '');
      if (!transient || process.platform !== 'win32' || attempt >= 10) throw error;
      await sleep(20 * (attempt + 1));
    }
  }
}
