import type { Env } from './paths.js';
import { normalizeStore } from './validate.js';

/** Lists the variables ShopShift's own shell integration exported, so they are never called conflicts. */
export const MANAGED_VARIABLE = 'SHOPSHIFT_MANAGED';

export const THEME_TOKEN_VARIABLE = 'SHOPIFY_CLI_THEME_TOKEN';

/** Credentials that make Shopify CLI ignore the account selected with --auth-alias. */
const CREDENTIAL_VARIABLES = [
  THEME_TOKEN_VARIABLE,
  'SHOPIFY_CLI_IDENTITY_TOKEN',
  'SHOPIFY_CLI_REFRESH_TOKEN',
  'SHOPIFY_CLI_PARTNERS_TOKEN',
  'SHOPIFY_APP_AUTOMATION_TOKEN',
  'SHOPIFY_SERVICE_ACCOUNT_TOKEN',
] as const;

/**
 * Every Shopify CLI flag can also be set through SHOPIFY_FLAG_*. Those that choose a store, an
 * account, a theme or what may be overwritten are removed from child processes; only presentation
 * settings are let through. It is an allowlist so that flags Shopify adds later are safe by default.
 */
const PASSTHROUGH_FLAGS = new Set([
  'SHOPIFY_FLAG_VERBOSE',
  'SHOPIFY_FLAG_NO_COLOR',
  'SHOPIFY_FLAG_NO_INPUT',
  'SHOPIFY_FLAG_JSON',
  'SHOPIFY_FLAG_OPEN',
  'SHOPIFY_FLAG_LIVE_RELOAD',
  'SHOPIFY_FLAG_ERROR_OVERLAY',
  'SHOPIFY_FLAG_STANDARD_EVENTS_INSPECTOR',
  'SHOPIFY_FLAG_STORE_PASSWORD',
  'SHOPIFY_FLAG_NOTIFY',
  'SHOPIFY_FLAG_STRICT_PUSH',
  'SHOPIFY_FLAG_FAIL_LEVEL',
  'SHOPIFY_FLAG_OUTPUT',
]);

export interface EnvironmentConflict {
  variable: string;
  kind: 'store' | 'account' | 'credential' | 'flag';
  /** Safe to print. Never contains a credential's value. */
  description: string;
}

export interface ShopifyContext {
  store?: string | undefined;
  alias?: string | undefined;
  /** Authenticate with SHOPIFY_CLI_THEME_TOKEN instead of an account. */
  useThemeToken?: boolean | undefined;
}

/** Finds variables that would pull a Shopify command away from the given workspace context. */
export function findEnvironmentConflicts(env: Env, context: ShopifyContext): EnvironmentConflict[] {
  const managed = managedVariables(env);
  const conflicts: EnvironmentConflict[] = [];

  for (const variable of CREDENTIAL_VARIABLES) {
    if (!isSet(env[variable])) continue;
    if (variable === THEME_TOKEN_VARIABLE && context.useThemeToken === true) continue;
    conflicts.push({
      variable,
      kind: 'credential',
      description: 'is set, which overrides the workspace account',
    });
  }

  for (const [variable, value] of Object.entries(env)) {
    if (!variable.startsWith('SHOPIFY_FLAG_') || !isSet(value)) continue;
    if (PASSTHROUGH_FLAGS.has(variable) || managed.has(variable)) continue;
    if (variable === 'SHOPIFY_FLAG_STORE') {
      if (context.store !== undefined && sameStore(value, context.store)) continue;
      conflicts.push({ variable, kind: 'store', description: `points at ${printable(value)}` });
    } else if (variable === 'SHOPIFY_FLAG_AUTH_ALIAS') {
      if (value === context.alias) continue;
      conflicts.push({ variable, kind: 'account', description: `selects ${printable(value)}` });
    } else {
      conflicts.push({
        variable,
        kind: 'flag',
        description: 'is set, which changes what the command does',
      });
    }
  }
  return conflicts.sort((a, b) => a.variable.localeCompare(b.variable));
}

/**
 * Builds the environment for a Shopify CLI process. Context travels as explicit flags, so anything
 * inherited that could contradict them is dropped.
 */
export function buildShopifyEnvironment(env: Env, context: ShopifyContext = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [variable, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (variable.startsWith('SHOPIFY_FLAG_') && !PASSTHROUGH_FLAGS.has(variable)) continue;
    if ((CREDENTIAL_VARIABLES as readonly string[]).includes(variable)) {
      if (!(variable === THEME_TOKEN_VARIABLE && context.useThemeToken === true)) continue;
    }
    result[variable] = value;
  }
  return result;
}

/** For the doctor: which Shopify credentials exist in the environment, by name only. */
export function presentCredentialVariables(env: Env): string[] {
  return CREDENTIAL_VARIABLES.filter((variable) => isSet(env[variable]));
}

/**
 * The variables the shell integration exported. Only the two context flags can be claimed this way,
 * so setting SHOPSHIFT_MANAGED by hand can never hide a credential or a target flag.
 */
export function managedVariables(env: Env): Set<string> {
  const claimable = new Set(['SHOPIFY_FLAG_STORE', 'SHOPIFY_FLAG_AUTH_ALIAS']);
  return new Set((env[MANAGED_VARIABLE] ?? '').split(/\s+/).filter((name) => claimable.has(name)));
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function sameStore(value: string, store: string): boolean {
  try {
    return normalizeStore(value) === store;
  } catch {
    return false;
  }
}

function printable(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control characters.
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 80);
}
