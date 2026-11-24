import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { isNodeError } from '../errors.js';

export interface LockOptions {
  /** How long to wait for the current holder before giving up. */
  timeoutMs: number;
  /** Age after which a lock is considered abandoned even if its process still exists. */
  staleMs: number;
  retryMs?: number;
  /** Called once, the first time acquisition has to wait. */
  onWait?: (holder: LockHolder | undefined) => void;
}

export interface LockHolder {
  pid: number;
  label: string;
}

export interface Lock {
  release(): void;
}

interface LockRecord extends LockHolder {
  token: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return isNodeError(error) && error.code === 'EPERM';
  }
}

/** Acquires an exclusive cross-process lock, or returns undefined on timeout. */
export async function acquireLock(
  file: string,
  label: string,
  options: LockOptions,
): Promise<Lock | undefined> {
  const token = randomBytes(12).toString('hex');
  const deadline = Date.now() + options.timeoutMs;
  let waited = false;

  for (;;) {
    if (tryCreate(file, { pid: process.pid, label, token })) return makeLock(file, token);

    if (isStale(file, options.staleMs)) {
      breakStale(file, options.staleMs);
      continue;
    }
    if (!waited) {
      waited = true;
      options.onWait?.(readRecord(file));
    }
    if (Date.now() >= deadline) return undefined;
    // Jitter keeps many waiters from retrying in lockstep.
    await sleep((options.retryMs ?? 25) * (0.5 + Math.random()));
  }
}

function tryCreate(file: string, record: LockRecord): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(file, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') return false;
    // Windows reports a file that is mid-deletion as EPERM/EBUSY.
    if (
      process.platform === 'win32' &&
      isNodeError(error) &&
      ['EPERM', 'EBUSY'].includes(error.code ?? '')
    ) {
      return false;
    }
    throw error;
  }
  try {
    writeSync(descriptor, JSON.stringify(record));
  } finally {
    closeSync(descriptor);
  }
  return true;
}

function makeLock(file: string, token: string): Lock {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    // Only remove the lock if it is still ours; it may have been broken as stale.
    if (readRecord(file)?.token === token) rmSync(file, { force: true });
  };
  process.on('exit', release);
  return { release };
}

function readRecord(file: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, label, token } = parsed as Partial<LockRecord>;
    if (typeof pid !== 'number' || typeof token !== 'string') return undefined;
    return { pid, token, label: typeof label === 'string' ? label : 'unknown' };
  } catch {
    return undefined;
  }
}

function isStale(file: string, staleMs: number): boolean {
  let age: number;
  try {
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    return false;
  }
  if (age > staleMs) return true;
  const record = readRecord(file);
  // An unreadable record may simply be mid-write, so give its owner a moment to finish.
  if (record === undefined) return age > 1_000;
  return !isProcessAlive(record.pid);
}

/**
 * Removing a stale lock needs its own lock. Otherwise two waiters can both judge the same lock
 * stale, and the slower one would delete the lock the faster one has just legitimately created.
 */
function breakStale(file: string, staleMs: number): void {
  const breaker = `${file}.break`;
  if (!tryCreate(breaker, { pid: process.pid, label: 'breaker', token: 'breaker' })) {
    if (isStale(breaker, 5_000)) rmSync(breaker, { force: true });
    return;
  }
  try {
    if (isStale(file, staleMs)) rmSync(file, { force: true });
  } finally {
    rmSync(breaker, { force: true });
  }
}
