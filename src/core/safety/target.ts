import { ShopShiftError } from '../errors.js';
import type { RemoteTheme } from '../shopify/client.js';
import type { ForwardedArgs } from '../shopify/flags.js';
import type { ThemeEnvironment } from '../theme-config.js';

export type ThemeTarget =
  | { kind: 'theme'; ref: string }
  | { kind: 'live' }
  | { kind: 'development'; context?: string | undefined }
  | { kind: 'unpublished'; name?: string | undefined };

export type TargetOrigin = 'flag' | 'workspace' | 'environment';

export interface ResolvedTarget {
  target: ThemeTarget;
  origin: TargetOrigin;
}

const TARGET_BOOLEANS = ['live', 'development', 'unpublished'] as const;
type TargetBoolean = (typeof TARGET_BOOLEANS)[number];

/**
 * Works out which theme a command will act on, without touching the network.
 *
 * Shopify CLI merges three sources: command-line flags, then environment variables (which ShopShift
 * removes), then shopify.theme.toml. Two details make that dangerous:
 *
 * - A boolean in the TOML cannot be switched off from the command line.
 * - `live` silently wins over `theme`, so `--theme 123` plus `live = true` writes to the live theme.
 *
 * Any combination that names two different themes is therefore refused rather than interpreted.
 */
export function resolveTarget(input: {
  flags: ForwardedArgs;
  workspaceThemeId?: string | undefined;
  environment?: ThemeEnvironment | undefined;
}): ResolvedTarget | undefined {
  const fromFlags = readFlags(input.flags);
  const fromEnvironment = readEnvironment(input.environment);
  const environmentLabel =
    input.environment === undefined
      ? ''
      : `[environments.${input.environment.name}] in shopify.theme.toml`;

  if (fromFlags !== undefined) {
    const stray = fromEnvironment?.booleans.filter((name) => name !== fromFlags.kind) ?? [];
    if (stray.length > 0) {
      throw conflict(
        `${describeTarget(fromFlags)} was requested, but ${environmentLabel} also sets ${stray.join(' and ')}.`,
        `Remove ${stray.join(' and ')} from that environment. Flags cannot switch it off.`,
      );
    }
    return { target: fromFlags, origin: 'flag' };
  }

  if (input.workspaceThemeId !== undefined) {
    const booleans = fromEnvironment?.booleans ?? [];
    if (booleans.length > 0) {
      throw conflict(
        `The workspace targets theme #${input.workspaceThemeId}, but ${environmentLabel} sets ${booleans.join(' and ')}.`,
        'Keep the target in one place: clear it from the workspace (shopshift edit --no-theme) or from the TOML.',
      );
    }
    if (fromEnvironment?.theme !== undefined && fromEnvironment.theme !== input.workspaceThemeId) {
      throw conflict(
        `The workspace targets theme #${input.workspaceThemeId}, but ${environmentLabel} targets "${fromEnvironment.theme}".`,
        'Pass --theme to choose one for this command, or make the two agree.',
      );
    }
    return { target: { kind: 'theme', ref: input.workspaceThemeId }, origin: 'workspace' };
  }

  if (fromEnvironment === undefined) return undefined;
  const { booleans, theme, context } = fromEnvironment;
  if (
    booleans.length > 1 ||
    (booleans.length === 1 && theme !== undefined && booleans[0] !== 'unpublished')
  ) {
    const named = [...booleans, ...(theme === undefined ? [] : [`theme = "${theme}"`])];
    throw conflict(
      `${environmentLabel} sets ${named.join(' and ')}, which name different themes.`,
      'Keep one of them.',
    );
  }
  const [only] = booleans;
  if (only === 'live') return { target: { kind: 'live' }, origin: 'environment' };
  if (only === 'development')
    return { target: { kind: 'development', context }, origin: 'environment' };
  if (only === 'unpublished')
    return { target: { kind: 'unpublished', name: theme }, origin: 'environment' };
  return theme === undefined
    ? undefined
    : { target: { kind: 'theme', ref: theme }, origin: 'environment' };
}

function readFlags(flags: ForwardedArgs): ThemeTarget | undefined {
  const booleans = TARGET_BOOLEANS.filter((name) => flags.has(name));
  const theme = flags.value('theme');
  const context = flags.value('development-context');

  if (booleans.length > 1) {
    throw conflict(
      `${booleans.map((name) => `--${name}`).join(' and ')} name different themes.`,
      'Use one of them.',
    );
  }
  const [only] = booleans;
  if (theme !== undefined && only !== undefined && only !== 'unpublished') {
    throw conflict(`--${only} and --theme name different themes.`, 'Use one of them.');
  }
  if (context !== undefined && only !== 'development') {
    throw conflict(
      '--development-context only makes sense with --development.',
      'Add --development.',
    );
  }
  if (only === 'live') return { kind: 'live' };
  if (only === 'development') return { kind: 'development', context };
  if (only === 'unpublished') return { kind: 'unpublished', name: theme };
  return theme === undefined ? undefined : { kind: 'theme', ref: theme };
}

function readEnvironment(
  environment: ThemeEnvironment | undefined,
): { booleans: TargetBoolean[]; theme?: string; context?: string } | undefined {
  if (environment === undefined) return undefined;
  const { settings } = environment;
  const booleans = TARGET_BOOLEANS.filter((name) => settings[name] === true);
  const { theme } = settings;
  if (Array.isArray(theme)) {
    throw conflict(
      `[environments.${environment.name}] in shopify.theme.toml lists several themes.`,
      'Pass --theme to choose one.',
    );
  }
  const context = settings['development-context'];
  if (booleans.length === 0 && theme === undefined) return undefined;
  return {
    booleans,
    ...(theme === undefined ? {} : { theme: String(theme) }),
    ...(typeof context === 'string' ? { context } : {}),
  };
}

/**
 * Turns a theme ID or name into exactly one theme. Shopify CLI accepts wildcards and takes the first
 * match when several themes share a name; neither is acceptable when overwriting files.
 */
export function resolveTheme(
  reference: string,
  themes: readonly RemoteTheme[],
  store: string,
): RemoteTheme {
  if (reference.includes('*')) {
    throw new ShopShiftError(
      'TARGET_AMBIGUOUS',
      `"${reference}" is a pattern, not a single theme.`,
      {
        hint: 'Use the theme ID. List them with: shopshift themes',
      },
    );
  }
  const wanted = reference
    .trim()
    .replace(/^#(?=\d+$)/, '')
    .toLowerCase();
  const matches = themes.filter(
    (theme) => theme.id === wanted || theme.name.toLowerCase() === wanted,
  );
  const [match] = matches;
  if (match === undefined) {
    throw new ShopShiftError('TARGET_NOT_FOUND', `There is no theme "${reference}" on ${store}.`, {
      hint: 'List the themes with: shopshift themes',
    });
  }
  if (matches.length > 1) {
    throw new ShopShiftError(
      'TARGET_AMBIGUOUS',
      `${matches.length} themes on ${store} match "${reference}".`,
      {
        details: matches.map((theme) => `#${theme.id}  ${theme.name} (${theme.role})`),
        hint: 'Use a theme ID that is not also the name of another theme.',
      },
    );
  }
  return match;
}

export function findLiveTheme(themes: readonly RemoteTheme[], store: string): RemoteTheme {
  const live = themes.filter(isLive);
  const [theme] = live;
  if (theme === undefined || live.length > 1) {
    throw new ShopShiftError(
      'TARGET_AMBIGUOUS',
      `Could not tell which theme is live on ${store}.`,
      {
        hint: 'Use --theme with the theme ID.',
      },
    );
  }
  return theme;
}

const KNOWN_SAFE_ROLES = new Set(['unpublished', 'development', 'demo', 'locked', 'archived']);

export function isLive(theme: RemoteTheme): boolean {
  return theme.role === 'live' || theme.role === 'main';
}

/** A role ShopShift has never heard of gets the same protection as a live theme. */
export function needsLiveConfirmation(theme: RemoteTheme): boolean {
  return !KNOWN_SAFE_ROLES.has(theme.role);
}

export function describeTarget(target: ThemeTarget): string {
  switch (target.kind) {
    case 'theme':
      return /^\d+$/.test(target.ref) ? `Theme #${target.ref}` : `Theme "${target.ref}"`;
    case 'live':
      return 'The live theme';
    case 'development':
      return 'The development theme';
    case 'unpublished':
      return 'A new unpublished theme';
  }
}

function conflict(message: string, hint: string): ShopShiftError {
  return new ShopShiftError('TARGET_AMBIGUOUS', message, { hint });
}
