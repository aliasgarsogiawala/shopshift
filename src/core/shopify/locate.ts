import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { ShopShiftError } from '../errors.js';
import type { Env } from '../paths.js';

export const SHOPIFY_BIN_VARIABLE = 'SHOPSHIFT_SHOPIFY_BIN';
export const INSTALL_HINT = 'Install it with: npm install -g @shopify/cli@latest';

export interface ShopifyExecutable {
  /** What to spawn, plus the arguments that must come first. */
  readonly file: string;
  readonly prefix: readonly string[];
  /** The resolved Shopify CLI entry point, for display and cache keys. */
  readonly path: string;
}

export function locateShopify(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
): ShopifyExecutable {
  const override = env[SHOPIFY_BIN_VARIABLE];
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override) || !isFile(override)) {
      throw new ShopShiftError(
        'SHOPIFY_NOT_FOUND',
        `${SHOPIFY_BIN_VARIABLE} does not point at a file.`,
        {
          hint: 'Use an absolute path, or unset the variable.',
        },
      );
    }
    return describe(override, platform);
  }

  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    // A relative PATH entry would let the current project decide which program we run.
    if (directory === '' || !path.isAbsolute(directory)) continue;
    const names = platform === 'win32' ? ['shopify.cmd', 'shopify.exe'] : ['shopify'];
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (isFile(candidate) && (platform === 'win32' || isExecutable(candidate))) {
        return describe(candidate, platform);
      }
    }
  }
  throw new ShopShiftError(
    'SHOPIFY_NOT_FOUND',
    'Shopify CLI is not installed, or not on your PATH.',
    {
      hint: INSTALL_HINT,
    },
  );
}

function describe(candidate: string, platform: NodeJS.Platform): ShopifyExecutable {
  const real = realpathSync(candidate);
  if (/\.[cm]?js$/.test(real) && (platform === 'win32' || !isExecutable(real))) {
    return { file: process.execPath, prefix: [real], path: real };
  }
  if (platform === 'win32' && real.toLowerCase().endsWith('.cmd')) {
    // Batch files can only be started through a shell, which would need argument quoting. The npm
    // shim only launches this script, so start the script instead.
    const script = path.join(
      path.dirname(real),
      'node_modules',
      '@shopify',
      'cli',
      'bin',
      'run.js',
    );
    if (isFile(script)) return { file: process.execPath, prefix: [script], path: script };
    throw new ShopShiftError(
      'SHOPIFY_NOT_FOUND',
      `Found ${real}, but not the Shopify CLI behind it.`,
      {
        hint: `${INSTALL_HINT}, or set ${SHOPIFY_BIN_VARIABLE} to its run.js.`,
      },
    );
  }
  return { file: candidate, prefix: [], path: real };
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
