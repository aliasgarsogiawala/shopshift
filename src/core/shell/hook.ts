import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Env, ShopShiftPaths } from '../paths.js';

export type Shell = 'zsh' | 'bash';

/** Deliberately small: this module runs on every directory change, so it must load almost nothing. */

interface HookWorkspace {
  id: string;
  name: string;
  store: string;
  alias: string;
  directory: string;
}

export interface HookResult {
  /** Shell code to evaluate. */
  script: string;
  /** Human-readable lines for stderr. */
  messages: string[];
}

const MANAGED = 'SHOPSHIFT_MANAGED';
/** The only variables the hook ever sets or removes, whatever SHOPSHIFT_MANAGED claims. */
const CONTEXT_VARIABLES = new Set([
  'SHOPSHIFT_WORKSPACE',
  'SHOPIFY_FLAG_STORE',
  'SHOPIFY_FLAG_AUTH_ALIAS',
]);
const STORE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function runHook(paths: ShopShiftPaths, env: Env, cwd: string): HookResult {
  const { workspaces, active } = readWorkspaces(paths.configFile);
  const matches = detect(workspaces, cwd);
  const chosen = matches.length > 1 ? matches.find((item) => item.id === active) : matches[0];
  const messages: string[] = [];

  const previous = env.SHOPSHIFT_WORKSPACE;
  const managed = new Set(
    (env[MANAGED] ?? '').split(/\s+/).filter((name) => CONTEXT_VARIABLES.has(name)),
  );
  const desired = new Map<string, string>();
  if (chosen !== undefined) {
    desired.set('SHOPSHIFT_WORKSPACE', chosen.id);
    desired.set('SHOPIFY_FLAG_STORE', chosen.store);
    desired.set('SHOPIFY_FLAG_AUTH_ALIAS', chosen.alias);
  }

  const lines: string[] = [];
  const nowManaged: string[] = [];
  for (const name of managed) {
    if (!desired.has(name)) lines.push(`unset ${name}`);
  }
  for (const [name, value] of desired) {
    const current = env[name];
    if (
      current !== undefined &&
      current !== '' &&
      !managed.has(name) &&
      name !== 'SHOPSHIFT_WORKSPACE'
    ) {
      // The developer set this one. Never overwrite it, and never clean it up later either.
      if (current !== value) messages.push(`shopshift: leaving your own ${name} in place`);
      continue;
    }
    nowManaged.push(name);
    if (current !== value) lines.push(`export ${name}=${quote(value)}`);
  }

  if (nowManaged.length > 0) {
    const value = nowManaged.join(' ');
    if (env[MANAGED] !== value) lines.push(`export ${MANAGED}=${quote(value)}`);
  } else if (env[MANAGED] !== undefined) {
    lines.push(`unset ${MANAGED}`);
  }

  if (chosen !== undefined && chosen.id !== previous) {
    messages.unshift(`shopshift: ${chosen.name} · ${chosen.store}`);
  } else if (chosen === undefined && matches.length > 1 && lines.length > 0) {
    messages.unshift(
      `shopshift: ${matches.length} workspaces share this directory (shopshift use <workspace>)`,
    );
  }
  return { script: lines.join('\n'), messages };
}

/** Single quotes are the only POSIX quoting with no special characters inside them. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Tolerant on purpose. A broken config must not print errors at every prompt; `doctor` reports it. */
function readWorkspaces(file: string): { workspaces: HookWorkspace[]; active: string | undefined } {
  let config: Record<string, unknown>;
  try {
    config = asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { workspaces: [], active: undefined };
  }
  const accounts = asRecord(config.accounts);
  const workspaces: HookWorkspace[] = [];
  for (const value of Object.values(asRecord(config.workspaces))) {
    const { id, name, store, account, directory } = asRecord(value);
    const alias =
      typeof account === 'string' && Object.hasOwn(accounts, account)
        ? asRecord(accounts[account]).alias
        : undefined;
    if (typeof id !== 'string' || !ID.test(id)) continue;
    if (typeof store !== 'string' || !STORE.test(store)) continue;
    if (typeof alias !== 'string' || alias === '' || alias.startsWith('-') || CONTROL.test(alias))
      continue;
    if (typeof directory !== 'string' || directory === '') continue;
    const label = typeof name === 'string' && !CONTROL.test(name) ? name : id;
    workspaces.push({ id, name: label, store, alias, directory });
  }
  return {
    workspaces,
    active: typeof config.activeWorkspace === 'string' ? config.activeWorkspace : undefined,
  };
}

function detect(workspaces: readonly HookWorkspace[], cwd: string): HookWorkspace[] {
  const here = real(cwd);
  let deepest = -1;
  let matches: HookWorkspace[] = [];
  for (const workspace of workspaces) {
    const directory = real(workspace.directory);
    const relative = path.relative(directory, here);
    if (relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative))) continue;
    if (directory.length > deepest) {
      deepest = directory.length;
      matches = [workspace];
    } else if (directory.length === deepest) {
      matches.push(workspace);
    }
  }
  return matches;
}

function real(target: string): string {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
