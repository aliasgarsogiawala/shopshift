import type { ThemeTarget } from '../safety/target.js';
import type { ThemeCommand } from './flags.js';

export interface ThemeInvocation {
  command: ThemeCommand;
  store?: string | undefined;
  /** Omitted when authenticating with a theme token. */
  alias?: string | undefined;
  environment?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  target?: ThemeTarget | undefined;
  /** Arguments forwarded verbatim, already stripped of everything above. */
  rest: readonly string[];
}

/** Flags ShopShift owns. They are removed from forwarded arguments and written back explicitly. */
export const CONTEXT_FLAGS = ['store', 'auth-alias', 'environment', 'port', 'path'] as const;
export const TARGET_FLAGS = [
  'theme',
  'live',
  'development',
  'development-context',
  'unpublished',
] as const;

export function buildThemeArgs(invocation: ThemeInvocation): string[] {
  const args = ['theme', invocation.command];
  if (invocation.store !== undefined) args.push('--store', invocation.store);
  if (invocation.alias !== undefined) args.push('--auth-alias', invocation.alias);
  if (invocation.environment !== undefined) args.push('--environment', invocation.environment);
  if (invocation.port !== undefined) args.push('--port', String(invocation.port));
  if (invocation.path !== undefined) args.push('--path', invocation.path);
  args.push(...targetArgs(invocation.target));
  args.push(...invocation.rest);
  return args;
}

function targetArgs(target: ThemeTarget | undefined): string[] {
  switch (target?.kind) {
    case 'theme':
      return ['--theme', target.ref];
    case 'live':
      return ['--live'];
    case 'development':
      return target.context === undefined
        ? ['--development']
        : ['--development', '--development-context', target.context];
    case 'unpublished':
      return target.name === undefined
        ? ['--unpublished']
        : ['--unpublished', '--theme', target.name];
    default:
      return [];
  }
}

/** For display only. ShopShift never hands a command line to a shell. */
export function formatCommand(args: readonly string[]): string {
  return ['shopify', ...args]
    .map((argument) =>
      /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ');
}
