import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ShopShiftError } from '../errors.js';
import { writeFileAtomic } from '../fs/atomic.js';
import type { ShopShiftPaths } from '../paths.js';

/**
 * `--auth-alias` arrived in 4.6.0, but ShopShift also relies on `--no-input`, `auth login --json` and
 * prompts being written to stderr, all of which arrived in 4.9.0.
 */
export const MINIMUM_SHOPIFY_CLI = '4.9.0';

/** The newest major version this release has been tested against. */
export const TESTED_SHOPIFY_CLI_MAJOR = 5;

export type VersionSupport = 'supported' | 'too-old' | 'untested' | 'unknown';

export function parseVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1];
}

export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA = ''] = a.split(/-(.*)/s);
  const [coreB = '', preB = ''] = b.split(/-(.*)/s);
  const left = coreA.split('.').map(Number);
  const right = coreB.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (preA === preB) return 0;
  // A prerelease sorts before the release it leads up to.
  if (preA === '') return 1;
  if (preB === '') return -1;
  return preA < preB ? -1 : 1;
}

export function classifyVersion(version: string | undefined): VersionSupport {
  if (version === undefined) return 'unknown';
  // Nightly and snapshot builds are published as 0.0.0-*, so their number says nothing.
  if (version.startsWith('0.0.0-')) return 'untested';
  if (compareVersions(version, MINIMUM_SHOPIFY_CLI) < 0) return 'too-old';
  return Number(version.split('.')[0]) > TESTED_SHOPIFY_CLI_MAJOR ? 'untested' : 'supported';
}

export function assertSupported(version: string | undefined): void {
  if (classifyVersion(version) !== 'too-old') return;
  throw new ShopShiftError(
    'SHOPIFY_UNSUPPORTED',
    `Shopify CLI ${version} is too old. ShopShift needs ${MINIMUM_SHOPIFY_CLI} or newer.`,
    { hint: 'Update with: shopify upgrade, or npm install -g @shopify/cli@latest' },
  );
}

interface CachedVersion {
  key: string;
  version: string;
}

/** Remembers the CLI's version between runs so that checking it costs a stat instead of a process. */
export class VersionCache {
  private readonly file: string;

  constructor(private readonly paths: ShopShiftPaths) {
    this.file = path.join(paths.stateDir, 'shopify-version.json');
  }

  read(executable: string): string | undefined {
    try {
      const cached = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CachedVersion>;
      return cached.key === this.key(executable) ? cached.version : undefined;
    } catch {
      return undefined;
    }
  }

  async write(executable: string, version: string): Promise<void> {
    try {
      mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.file, JSON.stringify({ key: this.key(executable), version }));
    } catch {
      // The cache is an optimisation; failing to write it must not fail the command.
    }
  }

  /**
   * npm gives every installed file the same fixed mtime, so the change time is what reveals an
   * upgrade: it cannot be set by an installer and is new for every file written.
   */
  private key(executable: string): string {
    const real = realpathSync(executable);
    const { ctimeMs, size, ino } = statSync(real);
    return `${real}:${ctimeMs}:${size}:${ino}`;
  }
}
