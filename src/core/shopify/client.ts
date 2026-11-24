import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import { buildShopifyEnvironment, type ShopifyContext } from '../environment.js';
import { CancelledError, redact, ShopShiftError } from '../errors.js';
import type { Env, ShopShiftPaths } from '../paths.js';
import {
  type CapturedOutput,
  type Command,
  capture as captureProcess,
  type ExitStatus,
  runInteractive,
} from '../process.js';
import { locateShopify, type ShopifyExecutable } from './locate.js';
import { assertSupported, parseVersion, VersionCache } from './version.js';

export interface RemoteTheme {
  id: string;
  name: string;
  role: string;
}

/** Identifies a store and the credentials to use for it. */
export interface StoreContext {
  store: string;
  alias?: string | undefined;
  useThemeToken?: boolean | undefined;
  environment?: string | undefined;
  /** Only needed when the project's shopify.theme.toml supplies the credentials. */
  cwd?: string | undefined;
}

export type AliasStatus = 'available' | 'missing';

const themeSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  name: z.string(),
  role: z.string(),
});
/** 4.x prints a bare array; 5.x wraps it in an object. */
const themeListSchema = z.union([
  z.array(themeSchema),
  z.object({ themes: z.array(themeSchema) }).transform((value) => value.themes),
]);
const themeInfoSchema = z.union([
  z
    .object({ development_theme_id: z.union([z.number(), z.string()]).nullable() })
    .transform((value) => value.development_theme_id),
  z
    .object({ developmentThemeId: z.union([z.number(), z.string()]).nullable() })
    .transform((value) => value.developmentThemeId),
]);
const loginSchema = z.object({ status: z.literal('success'), alias: z.string().min(1) });
const storeAuthSchema = z.object({
  sessions: z.array(z.object({ store: z.string().optional(), subdomain: z.string().optional() })),
});
const errorSchema = z.object({
  error: z.object({ message: z.string(), tryMessage: z.unknown().optional() }),
});

/** Everything ShopShift asks of the official Shopify CLI goes through here. */
export class ShopifyCli {
  private located: ShopifyExecutable | undefined;

  constructor(
    private readonly paths: ShopShiftPaths,
    private readonly env: Env = process.env,
  ) {}

  executable(): ShopifyExecutable {
    this.located ??= locateShopify(this.env);
    return this.located;
  }

  /** The installed version, or undefined if Shopify CLI ran but did not report one. */
  async version(options: { fresh?: boolean } = {}): Promise<string | undefined> {
    const executable = this.executable();
    const cache = new VersionCache(this.paths);
    if (options.fresh !== true) {
      const cached = cache.read(executable.path);
      if (cached !== undefined) return cached;
    }
    const result = await capture(this.command(['version'], {}), { timeoutMs: 20_000 });
    const version = result.code === 0 ? parseVersion(result.stdout) : undefined;
    if (version !== undefined) await cache.write(executable.path, version);
    return version;
  }

  async ensureSupported(): Promise<void> {
    assertSupported(await this.version());
  }

  /**
   * Asks Shopify CLI whether it has a session under an alias.
   *
   * `theme check --version` resolves `--auth-alias` like every theme command, but needs neither the
   * network nor a store, and never starts a login. It proves the session exists, not that it is
   * still valid: only a request to Shopify can show that.
   */
  async aliasStatus(alias: string): Promise<AliasStatus> {
    const result = await capture(
      this.command(['theme', 'check', '--version', '--auth-alias', alias], {}),
      { timeoutMs: 20_000 },
    );
    if (result.code === 0) return 'available';
    if (isMissingAlias(result)) return 'missing';
    throw failure('Could not check the Shopify session', result);
  }

  /** Shopify's own login, with its prompts and browser hand-off. */
  login(): Promise<ExitStatus> {
    return runInteractive(this.command(['auth', 'login'], {}));
  }

  /**
   * Shopify's account picker. Returns the exact alias of the chosen account, which Shopify CLI also
   * makes its current account. Prompts go to stderr, leaving stdout free for the result.
   */
  async pickAccount(): Promise<string> {
    const result = await runInteractive(this.command(['auth', 'login', '--json'], {}), {
      stdout: 'pipe',
    });
    const parsed = loginSchema.safeParse(parseJson(result.stdout));
    if (result.code !== 0 || !parsed.success) {
      throw new ShopShiftError('AUTH_MISSING', 'Shopify did not report a signed-in account.', {
        hint: 'Try again, or check your connection.',
      });
    }
    return parsed.data.alias;
  }

  /** Makes an existing session the one bare `shopify` commands use. Never opens a browser. */
  async switchCurrent(alias: string): Promise<void> {
    // Without this check an unknown alias would make Shopify CLI start a login instead of failing.
    if ((await this.aliasStatus(alias)) === 'missing') throw missingAlias(alias);
    const result = await capture(
      this.command(['auth', 'login', '--alias', alias, '--json', '--no-input'], {}),
      { timeoutMs: 20_000 },
    );
    if (result.code !== 0) throw failure('Could not switch the Shopify CLI account', result);
  }

  async listThemes(context: StoreContext): Promise<RemoteTheme[]> {
    const output = await this.query(['theme', 'list', ...storeArgs(context), '--json'], context);
    return expectShape(themeListSchema, output, 'theme list');
  }

  /** The development theme this machine uses for a store, if one has been created. */
  async developmentThemeId(context: StoreContext): Promise<string | undefined> {
    const output = await this.query(['theme', 'info', ...storeArgs(context), '--json'], context);
    const id = expectShape(themeInfoSchema, output, 'theme info');
    return id === null ? undefined : String(id);
  }

  /**
   * Stores with a `shopify store auth` session. `theme push` and `theme pull` prefer such a session
   * over the account chosen with --auth-alias.
   */
  async storesWithStoreAuth(): Promise<string[]> {
    const result = await capture(this.command(['store', 'auth', 'list', '--json'], {}), {
      timeoutMs: 20_000,
    });
    const parsed = storeAuthSchema.safeParse(parseJson(result.stdout));
    if (result.code !== 0 || !parsed.success) return [];
    return parsed.data.sessions.flatMap((session) => {
      if (session.store !== undefined) return [session.store.toLowerCase()];
      return session.subdomain === undefined
        ? []
        : [`${session.subdomain.toLowerCase()}.myshopify.com`];
    });
  }

  /** Runs a command that owns the terminal. */
  run(
    args: readonly string[],
    context: ShopifyContext & { cwd: string },
    options: Parameters<typeof runInteractive>[1] = {},
  ): Promise<ExitStatus & { stdout: string }> {
    return runInteractive(this.command(args, context, context.cwd), options);
  }

  private async query(args: string[], context: StoreContext): Promise<string> {
    // --no-input: if the session has expired, fail and let ShopShift explain, instead of opening a
    // browser in the middle of a background check.
    const result = await capture(this.command([...args, '--no-input'], context, context.cwd), {
      timeoutMs: 90_000,
    });
    if (result.code === 0) return result.stdout;
    if (isMissingAlias(result)) throw missingAlias(context.alias);
    if (isExpired(result)) throw expiredSession(context.alias);
    throw failure(`Could not reach ${context.store}`, result);
  }

  private command(args: readonly string[], context: ShopifyContext, cwd?: string): Command {
    const executable = this.executable();
    return {
      file: executable.file,
      args: [...executable.prefix, ...args],
      cwd: cwd ?? this.neutralDirectory(),
      env: buildShopifyEnvironment(this.env, context),
    };
  }

  /** A directory with no shopify.theme.toml above it, so that no environment is applied by accident. */
  private neutralDirectory(): string {
    mkdirSync(this.paths.stateDir, { recursive: true, mode: 0o700 });
    return this.paths.stateDir;
  }
}

async function capture(command: Command, options: { timeoutMs: number }): Promise<CapturedOutput> {
  const result = await captureProcess(command, options);
  if (result.interrupted) throw new CancelledError();
  return result;
}

function storeArgs(context: StoreContext): string[] {
  return [
    '--store',
    context.store,
    ...(context.alias === undefined ? [] : ['--auth-alias', context.alias]),
    ...(context.environment === undefined ? [] : ['--environment', context.environment]),
  ];
}

export function missingAlias(alias: string | undefined): ShopShiftError {
  return new ShopShiftError(
    'AUTH_MISSING',
    `Shopify CLI has no session for ${alias ?? 'this account'}.`,
    {
      hint: 'Sign in again with: shopshift account login',
    },
  );
}

export function expiredSession(alias: string | undefined): ShopShiftError {
  return new ShopShiftError(
    'AUTH_EXPIRED',
    `The Shopify session for ${alias ?? 'this store'} has expired.`,
    {
      hint: 'Sign in again with: shopshift account login',
    },
  );
}

function isMissingAlias(result: CapturedOutput): boolean {
  return flatten(result).includes('No authenticated account found');
}

function isExpired(result: CapturedOutput): boolean {
  const text = flatten(result);
  return (
    text.includes('Authorization is required to continue') ||
    text.includes('log in to Shopify') ||
    text.includes('currently available CLI credentials are invalid') ||
    text.includes('Error validating auth session')
  );
}

/** Shopify wraps errors in a box at 80 columns, which can split a sentence across lines. */
function flatten(result: CapturedOutput): string {
  return `${result.stdout}\n${result.stderr}`.replace(/[│╭╮╰╯─\s]+/g, ' ');
}

function failure(summary: string, result: CapturedOutput): ShopShiftError {
  if (result.timedOut) {
    return new ShopShiftError(
      'SHOPIFY_FAILED',
      `${summary}: Shopify CLI did not respond in time.`,
      {
        hint: 'Check your connection and try again.',
      },
    );
  }
  const structured = errorSchema.safeParse(parseJson(result.stdout));
  const message = structured.success
    ? structured.data.error.message
    : flatten(result)
        .replace(/\{"type":"diagnostic".*?\}(?=\s|$)/g, '')
        .trim();
  const attempt = structured.success ? structured.data.error.tryMessage : undefined;
  return new ShopShiftError('SHOPIFY_FAILED', `${summary}.`, {
    details: message === '' ? [] : [redact(message).slice(0, 600)],
    hint: typeof attempt === 'string' && attempt !== '' ? redact(attempt).slice(0, 300) : undefined,
  });
}

function expectShape<T>(schema: z.ZodType<T>, output: string, what: string): T {
  const parsed = schema.safeParse(parseJson(output));
  if (parsed.success) return parsed.data;
  throw new ShopShiftError('SHOPIFY_FAILED', `Shopify CLI's "${what}" output was not understood.`, {
    hint: 'This Shopify CLI version may be newer than ShopShift supports. Run: shopshift doctor',
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
