import path from 'node:path';
import type { Account, Workspace } from '../config/schema.js';
import { type EnvironmentConflict, findEnvironmentConflicts } from '../environment.js';
import { ShopShiftError } from '../errors.js';
import { displayPath, type Env, isDirectory, isWithin, tryRealpath } from '../paths.js';
import type { ForwardedArgs, ThemeCommand } from '../shopify/flags.js';
import { resolveThemeEnvironment, type ThemeEnvironment } from '../theme-config.js';
import { normalizeStore } from '../validate.js';

export interface GuardInput {
  command: ThemeCommand;
  workspace: Workspace;
  account: Account;
  flags: ForwardedArgs;
  env: Env;
  /** Where the developer is standing, which is what a relative --path refers to. */
  cwd: string;
  useThemeToken: boolean;
}

export interface GuardResult {
  environment: ThemeEnvironment | undefined;
  /** The name to pass as --environment. Undefined when only the implicit default applies. */
  environmentName: string | undefined;
  /** Directory Shopify CLI will read from or write to. */
  themeDirectory: string;
  /** True when `themeDirectory` must be passed as --path. */
  explicitPath: boolean;
  warnings: string[];
}

/** Commands that change files somewhere, as opposed to only reading. */
const WRITES: ReadonlySet<ThemeCommand> = new Set(['dev', 'pull', 'push']);

/**
 * Checks that nothing contradicts the workspace: not the flags being forwarded, not the environment,
 * not shopify.theme.toml. Anything ShopShift can neutralise becomes a warning; anything it cannot,
 * and anything at all before a push, stops the command.
 */
export function guardContext(input: GuardInput): GuardResult {
  const { command, workspace } = input;
  const warnings: string[] = [];

  if (!isDirectory(workspace.directory)) {
    throw new ShopShiftError(
      'DIRECTORY_INVALID',
      `${displayPath(workspace.directory)} no longer exists.`,
      {
        hint: `Point the workspace at its new location: shopshift edit ${workspace.id} --dir <path>`,
      },
    );
  }

  guardFlags(input);
  guardVariables(input, warnings);

  const { environment, environmentName } = selectEnvironment(input);
  if (environment !== undefined && WRITES.has(command))
    guardEnvironment(input, environment, warnings);

  return { environment, environmentName, ...resolvePath(input, environment), warnings };
}

function guardFlags({ command, workspace, account, flags, useThemeToken }: GuardInput): void {
  const store = flags.value('store');
  if (store !== undefined && normalizeStore(store) !== workspace.store) {
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `--store ${normalizeStore(store)} contradicts the workspace "${workspace.name}" (${workspace.store}).`,
      { hint: 'Choose the workspace for that store with -w, or add one with: shopshift add' },
    );
  }
  const alias = flags.value('auth-alias');
  if (alias !== undefined && alias !== account.alias) {
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `--auth-alias ${alias} contradicts the workspace account "${account.name}" (${account.alias}).`,
      { hint: `Change the account with: shopshift edit ${workspace.id} --account <account>` },
    );
  }
  if (flags.has('password')) {
    throw new ShopShiftError(
      'BLOCKED',
      'Passing --password on the command line exposes it to other processes.',
      {
        hint: useThemeToken
          ? 'Set SHOPIFY_CLI_THEME_TOKEN instead.'
          : 'Set SHOPIFY_CLI_THEME_TOKEN and add --use-theme-token.',
      },
    );
  }
  if (flags.values('environment').length > 1) {
    throw new ShopShiftError('CONTEXT_CONFLICT', 'ShopShift runs one environment at a time.', {
      hint: 'Run the command once per workspace.',
    });
  }
  if (command === 'push') {
    if (flags.has('publish')) {
      throw new ShopShiftError('BLOCKED', 'ShopShift never publishes a theme.', {
        hint: 'Push first, check the preview, then publish deliberately with: shopify theme publish',
      });
    }
    if (flags.unknown.length > 0) {
      throw new ShopShiftError(
        'BLOCKED',
        `ShopShift does not recognise ${flags.unknown.join(', ')}, so it cannot verify what this push would do.`,
        { hint: 'Remove it, or run Shopify CLI directly.' },
      );
    }
  }
  if (WRITES.has(command) && flags.has('force')) {
    throw new ShopShiftError('BLOCKED', "--force would skip Shopify CLI's own safety check.", {
      hint: 'Run the command from a workspace whose directory contains a theme.',
    });
  }
  if (WRITES.has(command) && flags.positionals.length > 0) {
    throw new ShopShiftError('USAGE', `Unexpected argument: ${flags.positionals.join(' ')}`, {
      hint: 'Choose a workspace with -w, and a theme with --theme.',
    });
  }
}

function guardVariables(
  { command, workspace, account, env, useThemeToken }: GuardInput,
  warnings: string[],
): void {
  const conflicts = findEnvironmentConflicts(env, {
    store: workspace.store,
    alias: account.alias,
    useThemeToken,
  });
  if (conflicts.length === 0) return;
  const lines = conflicts.map((conflict) => `${conflict.variable} ${conflict.description}`);
  if (command === 'push') {
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      'Your environment contradicts this workspace, so nothing was pushed.',
      {
        details: lines,
        hint: unsetHint(conflicts),
      },
    );
  }
  // Shopify is started without these variables, so the command still runs in the right context.
  for (const line of lines) warnings.push(`Ignoring ${line}.`);
}

function unsetHint(conflicts: readonly EnvironmentConflict[]): string {
  const unset = `unset ${conflicts.map((conflict) => conflict.variable).join(' ')}`;
  const token = conflicts.some((conflict) => conflict.variable === 'SHOPIFY_CLI_THEME_TOKEN');
  return token ? `${unset}  (or add --use-theme-token to authenticate with the token)` : unset;
}

function selectEnvironment({ workspace, flags, cwd }: GuardInput) {
  const name = flags.value('environment') ?? workspace.environment;
  const requested = flags.value('path');
  const directory = requested === undefined ? workspace.directory : path.resolve(cwd, requested);
  const environment = resolveThemeEnvironment(directory, name);
  return { environment, environmentName: name };
}

/** Settings from shopify.theme.toml that flags cannot undo, or that point somewhere else. */
function guardEnvironment(
  { command, workspace, useThemeToken }: GuardInput,
  environment: ThemeEnvironment,
  warnings: string[],
): void {
  const { settings } = environment;
  const label = `[environments.${environment.name}] in ${displayPath(environment.file)}`;

  if (settings.publish === true && command === 'push') {
    throw new ShopShiftError(
      'BLOCKED',
      `${label} sets publish = true, and ShopShift never publishes a theme.`,
      {
        hint: 'Remove it and publish deliberately with: shopify theme publish',
      },
    );
  }
  if (settings.force === true) {
    throw new ShopShiftError(
      'BLOCKED',
      `${label} sets force = true, which skips Shopify CLI's safety check.`,
      {
        hint: 'Remove it from the file.',
      },
    );
  }
  if (typeof settings.password === 'string' && settings.password !== '' && !useThemeToken) {
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `${label} contains a password, so the workspace account would be ignored.`,
      { hint: 'Remove the password, or add --use-theme-token to authenticate with it on purpose.' },
    );
  }
  if (typeof settings.store === 'string') {
    const store = safeStore(settings.store);
    if (store !== workspace.store) {
      const message = `${label} points at ${store ?? settings.store}, but the workspace uses ${workspace.store}.`;
      if (command === 'push') {
        throw new ShopShiftError('CONTEXT_CONFLICT', message, {
          hint: 'Make them agree, or choose a different environment with --environment.',
        });
      }
      warnings.push(`${message} Using the workspace store.`);
    }
  }
}

function resolvePath(
  { workspace, flags, cwd }: GuardInput,
  environment: ThemeEnvironment | undefined,
) {
  const fromFlag = flags.value('path');
  const fromFile =
    typeof environment?.settings.path === 'string' ? environment.settings.path : undefined;
  if (fromFlag === undefined && fromFile === undefined) {
    return { themeDirectory: workspace.directory, explicitPath: false };
  }
  // Shopify CLI runs inside the workspace directory, so that is what a path in the TOML refers to.
  const absolute =
    fromFlag === undefined
      ? path.resolve(workspace.directory, fromFile ?? '')
      : path.resolve(cwd, fromFlag);
  const real = tryRealpath(absolute);
  if (real === undefined || !isDirectory(real)) {
    throw new ShopShiftError('DIRECTORY_INVALID', `${displayPath(absolute)} is not a directory.`);
  }
  const root = tryRealpath(workspace.directory) ?? workspace.directory;
  if (!isWithin(root, real)) {
    throw new ShopShiftError(
      'CONTEXT_CONFLICT',
      `${displayPath(real)} is outside the workspace directory ${displayPath(root)}.`,
      { hint: 'Use the workspace that owns that directory.' },
    );
  }
  return { themeDirectory: real, explicitPath: true };
}

function safeStore(value: string): string | undefined {
  try {
    return normalizeStore(value);
  } catch {
    return undefined;
  }
}
