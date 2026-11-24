import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { acquireLock, type LockHolder } from './fs/lock.js';
import type { ShopShiftPaths } from './paths.js';

const WAIT_MS = 25_000;
const STALE_MS = 120_000;

export interface GateTicket {
  /** False when the wait timed out and the command is going ahead unprotected. */
  readonly exclusive: boolean;
  release(): void;
}

/**
 * Lets one Shopify CLI process start at a time.
 *
 * Shopify CLI keeps every account's session in a single file and rewrites the whole file when any
 * token is refreshed, and it keeps the "current store" in another shared file that it re-reads while
 * starting up. Two processes starting together can drop one account's refreshed session, or look up
 * one store's development theme under the other. See docs/CONCURRENCY.md for the reproduction.
 *
 * Spacing out startups closes that window. It cannot cover token refreshes that happen later, inside
 * a development server that is already running.
 */
export class LaunchGate {
  constructor(
    private readonly paths: ShopShiftPaths,
    private readonly waitMs: number = WAIT_MS,
  ) {}

  async enter(
    label: string,
    onWait?: (holder: LockHolder | undefined) => void,
  ): Promise<GateTicket> {
    mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(path.join(this.paths.stateDir, 'launch.lock'), label, {
      timeoutMs: this.waitMs,
      staleMs: STALE_MS,
      retryMs: 100,
      ...(onWait === undefined ? {} : { onWait }),
    });
    return lock === undefined
      ? { exclusive: false, release: () => {} }
      : { exclusive: true, release: () => lock.release() };
  }
}
