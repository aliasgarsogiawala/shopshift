import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isNodeError, ShopShiftError } from './errors.js';

export interface ShopShiftPaths {
  /** Directory holding the user's configuration. Safe to back up; contains no credentials. */
  readonly configDir: string;
  readonly configFile: string;
  readonly backupFile: string;
  /** Directory holding locks, caches and the registry of running sessions. Safe to delete. */
  readonly stateDir: string;
  readonly sessionsDir: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function resolvePaths(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ShopShiftPaths {
  const { configDir, stateDir } = baseDirectories(env, platform, home);
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    backupFile: path.join(configDir, 'config.json.bak'),
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
  };
}

function baseDirectories(env: Env, platform: NodeJS.Platform, home: string) {
  const override = absolute(env.SHOPSHIFT_CONFIG_DIR);
  if (override !== undefined)
    return { configDir: override, stateDir: path.join(override, 'state') };

  if (platform === 'win32') {
    const roaming = absolute(env.APPDATA) ?? path.join(home, 'AppData', 'Roaming');
    const local = absolute(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local');
    return { configDir: path.join(roaming, 'shopshift'), stateDir: path.join(local, 'shopshift') };
  }

  const xdgConfig = absolute(env.XDG_CONFIG_HOME);
  const xdgState = absolute(env.XDG_STATE_HOME);
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support', 'shopshift');
    return {
      configDir: xdgConfig === undefined ? support : path.join(xdgConfig, 'shopshift'),
      stateDir:
        xdgState === undefined
          ? path.join(home, 'Library', 'Caches', 'shopshift')
          : path.join(xdgState, 'shopshift'),
    };
  }
  return {
    configDir: path.join(xdgConfig ?? path.join(home, '.config'), 'shopshift'),
    stateDir: path.join(xdgState ?? path.join(home, '.local', 'state'), 'shopshift'),
  };
}

/** Relative overrides would make the active configuration depend on the working directory. */
function absolute(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || !path.isAbsolute(value)) return undefined;
  return path.normalize(value);
}

export function expandHome(input: string, home: string = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(home, input.slice(2));
  return input;
}

export function displayPath(target: string, home: string = homedir()): string {
  if (target === home) return '~';
  return target.startsWith(home + path.sep) ? `~${target.slice(home.length)}` : target;
}

/** Resolves user input to the canonical path of an existing directory, or explains why it cannot. */
export function resolveDirectory(input: string, cwd: string = process.cwd()): string {
  const raw = input.trim();
  if (raw === '') throw new ShopShiftError('DIRECTORY_INVALID', 'A project directory is required.');
  if (raw.includes('\0')) {
    throw new ShopShiftError('DIRECTORY_INVALID', 'The project directory contains a null byte.');
  }
  const candidate = path.resolve(cwd, expandHome(raw));
  try {
    const real = realpathSync.native(candidate);
    if (!statSync(real).isDirectory()) {
      throw new ShopShiftError(
        'DIRECTORY_INVALID',
        `${displayPath(candidate)} is not a directory.`,
        {
          hint: 'Choose the folder that contains your theme.',
        },
      );
    }
    return real;
  } catch (error) {
    if (error instanceof ShopShiftError) throw error;
    const reason =
      isNodeError(error) && error.code === 'EACCES' ? 'is not readable' : 'does not exist';
    throw new ShopShiftError('DIRECTORY_INVALID', `${displayPath(candidate)} ${reason}.`, {
      cause: error,
    });
  }
}

/** True when `target` is `parent` itself or anything below it. Both must be canonical paths. */
export function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function tryRealpath(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
