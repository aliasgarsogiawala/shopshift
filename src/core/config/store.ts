import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isNodeError, ShopShiftError } from '../errors.js';
import { writeFileAtomic } from '../fs/atomic.js';
import { acquireLock } from '../fs/lock.js';
import { displayPath, type ShopShiftPaths } from '../paths.js';
import { CONFIG_VERSION, type Config, configSchema, emptyConfig } from './schema.js';

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export class ConfigStore {
  constructor(readonly paths: ShopShiftPaths) {}

  exists(): boolean {
    return existsSync(this.paths.configFile);
  }

  /** Reads and validates the config. A missing file is an empty config, a broken one is an error. */
  read(): Config {
    let raw: string;
    try {
      raw = readFileSync(this.paths.configFile, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptyConfig();
      throw this.invalid(
        `could not be read (${isNodeError(error) ? error.code : 'unknown error'})`,
        error,
      );
    }
    return this.parse(raw);
  }

  /**
   * The only way to change the config. Re-reads inside the lock so that two ShopShift processes
   * never overwrite each other's changes.
   */
  async update<T>(mutate: (config: Config) => T): Promise<T> {
    mkdirSync(this.paths.configDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(this.paths.configDir, 'config.lock');
    const lock = await acquireLock(lockFile, 'config', {
      timeoutMs: LOCK_TIMEOUT_MS,
      staleMs: LOCK_STALE_MS,
    });
    if (lock === undefined) {
      throw new ShopShiftError(
        'CONFIG_LOCKED',
        'Another ShopShift process is saving its configuration.',
        {
          hint: `Try again. If this persists, delete ${displayPath(lockFile)}.`,
        },
      );
    }
    try {
      const config = this.read();
      const result = mutate(config);
      await this.write(config);
      return result;
    } finally {
      lock.release();
    }
  }

  private async write(config: Config): Promise<void> {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      throw new ShopShiftError(
        'CONFIG_INVALID',
        'ShopShift refused to save an invalid configuration.',
        {
          details: describe(parsed.error.issues),
        },
      );
    }
    if (this.exists()) copyFileSync(this.paths.configFile, this.paths.backupFile);
    await writeFileAtomic(this.paths.configFile, `${JSON.stringify(parsed.data, null, 2)}\n`);
  }

  private parse(raw: string): Config {
    let json: unknown;
    try {
      json = JSON.parse(raw.replace(/^﻿/, ''));
    } catch (error) {
      throw this.invalid('is not valid JSON', error);
    }
    const version =
      typeof json === 'object' && json !== null
        ? (json as { version?: unknown }).version
        : undefined;
    if (typeof version === 'number' && version > CONFIG_VERSION) {
      throw new ShopShiftError(
        'CONFIG_VERSION',
        `This configuration was written by a newer ShopShift (format ${version}).`,
        { hint: 'Update with: npm install -g shopshift@latest' },
      );
    }
    const parsed = configSchema.safeParse(json);
    if (!parsed.success)
      throw this.invalid('is not valid', parsed.error, describe(parsed.error.issues));
    return parsed.data;
  }

  private invalid(reason: string, cause: unknown, details: string[] = []): ShopShiftError {
    const hint = existsSync(this.paths.backupFile)
      ? `Fix the file by hand, or restore the previous version from ${displayPath(this.paths.backupFile)}.`
      : 'Fix the file by hand, or move it aside to start again.';
    return new ShopShiftError(
      'CONFIG_INVALID',
      `${displayPath(this.paths.configFile)} ${reason}.`,
      {
        hint,
        details,
        cause,
      },
    );
  }
}

function describe(issues: readonly { path: PropertyKey[]; message: string }[]): string[] {
  return issues
    .slice(0, 8)
    .map((issue) => `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`);
}
