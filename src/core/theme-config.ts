import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { ShopShiftError } from './errors.js';
import { displayPath } from './paths.js';

export const THEME_CONFIG_FILE = 'shopify.theme.toml';

export type EnvironmentSettings = Readonly<Record<string, unknown>>;

export interface ThemeEnvironment {
  file: string;
  name: string;
  /** True when Shopify CLI applies it on its own because it is called "default". */
  implicit: boolean;
  settings: EnvironmentSettings;
}

/** Looks upwards from a directory, exactly as Shopify CLI does. */
export function findThemeConfig(directory: string): string | undefined {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const candidate = path.join(current, THEME_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

export function readThemeEnvironments(file: string): Record<string, EnvironmentSettings> {
  let document: Record<string, unknown>;
  try {
    document = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ShopShiftError('CONTEXT_CONFLICT', `${displayPath(file)} could not be parsed.`, {
      hint: 'Fix the TOML syntax. ShopShift reads it to know which flags Shopify CLI will apply.',
      cause: error,
    });
  }
  const environments = document.environments;
  if (!isTable(environments)) return {};
  return Object.fromEntries(
    Object.entries(environments).filter((entry): entry is [string, EnvironmentSettings] =>
      isTable(entry[1]),
    ),
  );
}

/**
 * Resolves the environment Shopify CLI will merge into a command run from `directory`. With no name
 * it applies `[environments.default]` if there is one, which is easy to forget about.
 */
export function resolveThemeEnvironment(
  directory: string,
  name?: string,
): ThemeEnvironment | undefined {
  const file = findThemeConfig(directory);
  if (file === undefined) {
    if (name === undefined) return undefined;
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `The environment "${name}" needs a ${THEME_CONFIG_FILE}, but there is none in ${displayPath(directory)}.`,
      { hint: 'Create the file, or clear the environment from the workspace.' },
    );
  }
  const environments = readThemeEnvironments(file);
  const wanted = name ?? 'default';
  const settings = Object.hasOwn(environments, wanted) ? environments[wanted] : undefined;
  if (settings === undefined) {
    if (name === undefined) return undefined;
    const known = Object.keys(environments);
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `${displayPath(file)} has no environment called "${name}".`,
      {
        hint:
          known.length === 0 ? 'It defines no environments.' : `It defines: ${known.join(', ')}`,
      },
    );
  }
  return { file, name: wanted, implicit: name === undefined, settings };
}

function isTable(value: unknown): value is EnvironmentSettings {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}
