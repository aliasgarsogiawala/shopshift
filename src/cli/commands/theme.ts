import { getAccount } from '../../core/accounts.js';
import type { Account, Workspace } from '../../core/config/schema.js';
import { ShopShiftError } from '../../core/errors.js';
import { displayPath } from '../../core/paths.js';
import { DEFAULT_DEV_PORT, findFreePort, isPortFree, isPortListening } from '../../core/ports.js';
import { type ExitStatus, exitCodeOf } from '../../core/process.js';
import { type GuardResult, guardContext } from '../../core/safety/guard.js';
import { decideConfirmation, type PushPlan, planPush } from '../../core/safety/push.js';
import {
  describeTarget,
  isLive,
  needsLiveConfirmation,
  type ResolvedTarget,
  resolveTarget,
  resolveTheme,
  type ThemeTarget,
} from '../../core/safety/target.js';
import {
  buildThemeArgs,
  CONTEXT_FLAGS,
  formatCommand,
  TARGET_FLAGS,
  type ThemeInvocation,
} from '../../core/shopify/args.js';
import type { RemoteTheme, StoreContext } from '../../core/shopify/client.js';
import { type ForwardedArgs, parseForwarded, type ThemeCommand } from '../../core/shopify/flags.js';
import { storeHandle, validatePort } from '../../core/validate.js';
import { listWorkspaces } from '../../core/workspaces.js';
import { fields } from '../../ui/output.js';
import { symbols } from '../../ui/style.js';
import type { App } from '../app.js';
import { recoverAccount, withAuthRecovery } from '../auth.js';
import { chooseWorkspace } from '../select.js';

export interface ThemeOptions {
  workspace?: string;
  dryRun?: boolean;
  useThemeToken?: boolean;
  yes?: boolean;
  confirmLive?: string;
  allowSharedTheme?: boolean;
}

interface Prepared {
  workspace: Workspace;
  account: Account;
  flags: ForwardedArgs;
  guard: GuardResult;
  useThemeToken: boolean;
  /** False when stdin cannot answer, or the developer asked not to be prompted. */
  interactive: boolean;
}

/** Commands that are allowed to run from anywhere, using the active workspace. */
const ANYWHERE: ReadonlySet<ThemeCommand> = new Set(['dev', 'list', 'info', 'check']);
/** How long a short command keeps others from starting, at most. */
const GATE_HOLD_MS = 15_000;
const DEV_READY_TIMEOUT_MS = 60_000;

async function prepare(
  app: App,
  command: ThemeCommand,
  forwarded: readonly string[],
  options: ThemeOptions,
): Promise<Prepared> {
  const flags = parseForwarded(command, stripSeparator(forwarded));
  const config = app.store.read();
  const name = command === 'list' ? 'themes' : command;
  const { workspace, source } = await chooseWorkspace(app, config, name, options.workspace, {
    deliberate: !ANYWHERE.has(command),
  });
  const account = getAccount(config, workspace.account);
  const useThemeToken = options.useThemeToken === true;
  const guard = guardContext({
    command,
    workspace,
    account,
    flags,
    env: app.env,
    cwd: app.cwd,
    useThemeToken,
  });
  if (useThemeToken && !hasThemeToken(app, guard)) {
    throw new ShopShiftError(
      'AUTH_MISSING',
      '--use-theme-token was given, but there is no token to use.',
      {
        hint: 'Set SHOPIFY_CLI_THEME_TOKEN, or put a password in the shopify.theme.toml environment.',
      },
    );
  }
  if (source === 'active') {
    app.out.info(`Not inside a workspace. Using the active one: ${workspace.name}.`);
  }
  for (const warning of guard.warnings) app.out.warn(warning);
  await app.shopify.ensureSupported();
  return {
    workspace,
    account,
    flags,
    guard,
    useThemeToken,
    interactive: app.prompts.interactive && !flags.has('no-input'),
  };
}

function hasThemeToken(app: App, guard: GuardResult): boolean {
  const password = guard.environment?.settings.password;
  return (
    Boolean(app.env.SHOPIFY_CLI_THEME_TOKEN) || (typeof password === 'string' && password !== '')
  );
}

function stripSeparator(forwarded: readonly string[]): string[] {
  const index = forwarded.indexOf('--');
  return index === -1
    ? [...forwarded]
    : [...forwarded.slice(0, index), ...forwarded.slice(index + 1)];
}

function storeContext({ workspace, account, guard, useThemeToken }: Prepared): StoreContext {
  if (!useThemeToken) return { store: workspace.store, alias: account.alias };
  return {
    store: workspace.store,
    useThemeToken: true,
    environment: guard.environmentName,
    cwd: workspace.directory,
  };
}

function invocation(
  prepared: Prepared,
  command: ThemeCommand,
  rest: string[],
  extra: Partial<ThemeInvocation> = {},
): ThemeInvocation {
  const { workspace, account, guard, useThemeToken } = prepared;
  return {
    command,
    store: workspace.store,
    alias: useThemeToken ? undefined : account.alias,
    environment: guard.environmentName,
    path: guard.explicitPath ? guard.themeDirectory : undefined,
    rest,
    ...extra,
  };
}

/**
 * Starts a Shopify command under the launch gate. If it fails because the session is gone, offers to
 * sign in and runs it once more.
 */
async function launch(
  app: App,
  prepared: Prepared,
  request: ThemeInvocation,
  options: { settled?: (child: { exitCode: number | null }) => Promise<void> } = {},
): Promise<ExitStatus> {
  const start = async (current: ThemeInvocation): Promise<ExitStatus> => {
    const ticket = await app.gate.enter(prepared.workspace.id, (holder) =>
      app.out.info(`Waiting for ${holder?.label ?? 'another session'} to finish starting…`),
    );
    if (!ticket.exclusive) {
      app.out.warn(
        'Another Shopify command is still starting. Continuing without waiting any longer.',
      );
    }
    const timer = setTimeout(
      () => ticket.release(),
      options.settled === undefined ? GATE_HOLD_MS : DEV_READY_TIMEOUT_MS,
    );
    try {
      return await app.shopify.run(
        buildThemeArgs(current),
        {
          store: prepared.workspace.store,
          alias: prepared.account.alias,
          useThemeToken: prepared.useThemeToken,
          cwd: prepared.workspace.directory,
        },
        {
          onSpawn: (child) => {
            void options.settled?.(child).then(() => ticket.release());
          },
        },
      );
    } finally {
      clearTimeout(timer);
      ticket.release();
    }
  };

  const status = await start(request);
  if (
    status.code === 0 ||
    status.signal !== null ||
    prepared.useThemeToken ||
    request.alias === undefined
  )
    return status;
  // The child owned the terminal, so its error was not seen. Ask Shopify whether the session exists.
  const alias = await app.shopify.aliasStatus(request.alias).catch(() => 'available' as const);
  if (alias === 'available') return status;
  if (!prepared.interactive) {
    throw new ShopShiftError('AUTH_MISSING', `Shopify CLI has no session for ${request.alias}.`, {
      hint: `Run this in a terminal: shopshift account login ${prepared.account.id}`,
    });
  }
  const signIn = await app.prompts.confirm(
    `${request.alias} is not signed in. Sign in and try again?`,
    {
      initial: true,
      alternative: `shopshift account login ${prepared.account.id}`,
    },
  );
  if (!signIn) return status;
  const recovered = await recoverAccount(
    app,
    prepared.account,
    'missing',
    prepared.workspace.store,
  );
  return start({ ...request, alias: recovered.alias });
}

/** Ends the process the way the child ended, including by signal. */
function finish(status: ExitStatus): void {
  if (status.signal !== null && process.platform !== 'win32') {
    process.kill(process.pid, status.signal);
    return;
  }
  process.exitCode = exitCodeOf(status);
}

function reportDryRun(app: App, prepared: Prepared, request: ThemeInvocation): void {
  app.out.say(app.out.note.dim('Dry run. Nothing was started.'));
  app.out.print(`cd ${displayPath(prepared.workspace.directory)}`);
  app.out.print(formatCommand(buildThemeArgs(request)));
}

function header(app: App, prepared: Prepared, extra: string[] = []): void {
  const { workspace, account, useThemeToken } = prepared;
  const who = useThemeToken ? 'theme token' : account.name;
  const parts = [app.out.note.bold(workspace.name), workspace.store, who, ...extra];
  app.out.say(`${app.out.note.accent(symbols.arrow)} ${parts.join(app.out.note.dim(' · '))}`);
}

// ---------------------------------------------------------------------------------------------
// Read-only commands

export async function themes(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  const prepared = await prepare(app, 'list', forwarded, options);
  const request = invocation(prepared, 'list', prepared.flags.without(CONTEXT_FLAGS));
  if (options.dryRun === true) return reportDryRun(app, prepared, request);
  if (!prepared.flags.has('json')) header(app, prepared);
  finish(await launch(app, prepared, request));
}

export async function info(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  const prepared = await prepare(app, 'info', forwarded, options);
  const explicit = prepared.flags.has('theme') || prepared.flags.has('development');
  const target: ThemeTarget | undefined =
    !explicit && prepared.workspace.themeId !== undefined
      ? { kind: 'theme', ref: prepared.workspace.themeId }
      : undefined;
  const request = invocation(prepared, 'info', prepared.flags.without(CONTEXT_FLAGS), { target });
  if (options.dryRun === true) return reportDryRun(app, prepared, request);
  if (!prepared.flags.has('json')) header(app, prepared);
  finish(await launch(app, prepared, request));
}

/** Theme check is local, so it gets no store and no account, and does not need a session. */
export async function check(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  const prepared = await prepare(app, 'check', forwarded, options);
  const request = invocation(prepared, 'check', prepared.flags.without(CONTEXT_FLAGS), {
    store: undefined,
    alias: undefined,
  });
  if (options.dryRun === true) return reportDryRun(app, prepared, request);
  finish(await app.shopify.run(buildThemeArgs(request), { cwd: prepared.workspace.directory }));
}

// ---------------------------------------------------------------------------------------------
// dev

export async function dev(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  let prepared = await prepare(app, 'dev', forwarded, options);
  const { workspace, flags, guard } = prepared;

  const requestedTheme = flags.value('theme') ?? stringSetting(guard, 'theme');
  let theme: RemoteTheme | undefined;
  if (requestedTheme === undefined) {
    assertDevelopmentThemeUnused(app, workspace, options);
  } else {
    const found = await withAuthRecovery(
      app,
      prepared.account,
      workspace.store,
      async (account) => {
        prepared = { ...prepared, account };
        const list = await fetchThemes(app, prepared);
        return resolveTheme(requestedTheme, list, workspace.store);
      },
    );
    theme = found;
    if (needsLiveConfirmation(found)) await confirmLiveDevelopment(app, prepared, found, options);
  }

  const port = await choosePort(app, prepared);
  const request = invocation(prepared, 'dev', flags.without([...CONTEXT_FLAGS, 'theme']), {
    port,
    target: theme === undefined ? undefined : { kind: 'theme', ref: theme.id },
  });
  if (options.dryRun === true) return reportDryRun(app, prepared, request);

  header(app, prepared, [`http://127.0.0.1:${port}`]);
  await app.workspaces.touch(workspace.id);
  const unregister = await app.sessions.register({
    pid: process.pid,
    workspace: workspace.id,
    store: workspace.store,
    port,
    directory: workspace.directory,
    ...(theme === undefined ? {} : { themeId: theme.id }),
    startedAt: new Date().toISOString(),
  });
  let status: ExitStatus;
  try {
    // Checked again now that this session is visible to others, in case two were started together.
    if (theme === undefined) assertDevelopmentThemeUnused(app, workspace, options);
    status = await launch(app, prepared, request, {
      settled: (child) => waitUntilServing(port, child),
    });
  } finally {
    // Before finish(), which may end this process by signal and skip any later cleanup.
    unregister();
  }
  finish(status);
}

/** Resolves once the server answers twice in a row, so that Shopify's own port probe is not mistaken for it. */
async function waitUntilServing(port: number, child: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + DEV_READY_TIMEOUT_MS;
  let consecutive = 0;
  while (Date.now() < deadline && child.exitCode === null) {
    consecutive = (await isPortListening(port)) ? consecutive + 1 : 0;
    if (consecutive >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 400).unref());
  }
}

/**
 * Shopify CLI remembers one development theme per store on each machine. Two servers for the same
 * store would upload different files to the same theme.
 */
function assertDevelopmentThemeUnused(app: App, workspace: Workspace, options: ThemeOptions): void {
  if (options.allowSharedTheme === true) return;
  const sessions = app.sessions.list();
  const own = sessions.find((session) => session.pid === process.pid);
  const other = sessions.find(
    (session) =>
      session.pid !== process.pid &&
      session.store === workspace.store &&
      session.themeId === undefined &&
      // Of two started at once, the earlier one keeps the theme.
      (own === undefined ||
        session.startedAt < own.startedAt ||
        (session.startedAt === own.startedAt && session.pid < own.pid)),
  );
  if (other === undefined) return;
  const same = other.workspace === workspace.id;
  throw new ShopShiftError(
    'SESSION_CONFLICT',
    same
      ? `"${workspace.name}" is already running on http://127.0.0.1:${other.port}.`
      : `The workspace "${other.workspace}" is already using the development theme of ${workspace.store}.`,
    {
      details: [
        'Two servers would overwrite each other, because Shopify CLI keeps one development theme per store.',
      ],
      hint: 'Stop the other server, or give this one its own theme with --theme <id>.',
    },
  );
}

async function choosePort(
  app: App,
  { workspace, flags, guard, interactive }: Prepared,
): Promise<number> {
  const fromFlag = flags.value('port');
  const fromFile = stringSetting(guard, 'port');
  const preferred =
    fromFlag === undefined
      ? (workspace.port ?? (fromFile === undefined ? undefined : validatePort(fromFile)))
      : validatePort(fromFlag);
  const reserved = new Set([
    ...listWorkspaces(app.store.read()).flatMap((other) =>
      other.id === workspace.id ? [] : (other.port ?? []),
    ),
    ...app.sessions.list().map((session) => session.port),
  ]);

  if (preferred === undefined) {
    const free = await findFreePort(DEFAULT_DEV_PORT, reserved);
    if (free !== undefined) return free;
    throw new ShopShiftError('PORT_IN_USE', `No free port near ${DEFAULT_DEV_PORT}.`, {
      hint: 'Choose one with --port.',
    });
  }
  const owner = app.sessions.list().find((session) => session.port === preferred);
  if (owner === undefined && (await isPortFree(preferred))) return preferred;

  const message =
    owner === undefined
      ? `Port ${preferred} is already in use by another program.`
      : `Port ${preferred} is already in use by the workspace "${owner.workspace}".`;
  const alternative = await findFreePort(preferred + 1, reserved);
  if (alternative !== undefined && interactive) {
    app.out.warn(message);
    const accept = await app.prompts.confirm(`Use port ${alternative} this time?`, {
      initial: true,
      alternative: `shopshift dev --port ${alternative}`,
    });
    if (accept) return alternative;
  }
  throw new ShopShiftError('PORT_IN_USE', message, {
    details:
      owner === undefined && process.platform !== 'win32'
        ? [`See what is using it: lsof -nP -iTCP:${preferred} -sTCP:LISTEN`]
        : [],
    hint:
      alternative === undefined
        ? 'Choose another with --port.'
        : `shopshift dev --port ${alternative}`,
  });
}

async function confirmLiveDevelopment(
  app: App,
  prepared: Prepared,
  theme: RemoteTheme,
  options: ThemeOptions,
): Promise<void> {
  const { workspace, interactive, flags } = prepared;
  const decision = decideConfirmation(
    {
      ...planBase(prepared),
      origin: 'flag',
      target: { kind: 'theme', ref: theme.id },
      theme,
      live: isLive(theme),
      confirmation: 'live',
    },
    {
      interactive,
      yes: false,
      confirmLive: options.confirmLive,
      allowLive: flags.has('allow-live'),
    },
  );
  if (decision !== 'ask-live') return;
  app.out.say(
    `${app.out.note.live(' LIVE ')} "${theme.name}" #${theme.id} is what customers see on ${workspace.store}. Every save will change it.`,
  );
  await typeStoreName(
    app,
    workspace,
    `Type ${storeHandle(workspace.store)} to develop on the live theme`,
  );
}

// ---------------------------------------------------------------------------------------------
// pull

export async function pull(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  const prepared = await prepare(app, 'pull', forwarded, options);
  const { workspace, flags, guard } = prepared;
  const resolved = resolveTarget({
    flags,
    workspaceThemeId: workspace.themeId,
    environment: guard.environment,
  });
  if (resolved?.target.kind === 'theme' && resolved.target.ref.includes('*')) {
    throw new ShopShiftError(
      'TARGET_AMBIGUOUS',
      `"${resolved.target.ref}" is a pattern, not a single theme.`,
      {
        hint: 'Use the theme ID. List them with: shopshift themes',
      },
    );
  }
  const request = invocation(prepared, 'pull', flags.without([...CONTEXT_FLAGS, ...TARGET_FLAGS]), {
    target: resolved?.target,
  });
  if (options.dryRun === true) return reportDryRun(app, prepared, request);
  header(app, prepared, [
    resolved === undefined ? 'choose a theme' : describeTarget(resolved.target),
    `into ${displayPath(guard.themeDirectory)}`,
  ]);
  await app.workspaces.touch(workspace.id);
  finish(await launch(app, prepared, request));
}

// ---------------------------------------------------------------------------------------------
// push

export async function push(app: App, forwarded: string[], options: ThemeOptions): Promise<void> {
  let prepared = await prepare(app, 'push', forwarded, options);
  const { workspace, flags, guard } = prepared;
  const offline = resolveTarget({
    flags,
    workspaceThemeId: workspace.themeId,
    environment: guard.environment,
  });
  if (offline === undefined && !prepared.interactive) {
    throw new ShopShiftError('TARGET_AMBIGUOUS', 'No target theme was given. Nothing was pushed.', {
      hint: `Add --theme <id>, --development or --unpublished, or set a default: shopshift edit ${workspace.id} --theme <id>`,
    });
  }

  const { list, developmentThemeId, storeAuth } = await withAuthRecovery(
    app,
    prepared.account,
    workspace.store,
    async (account) => {
      prepared = { ...prepared, account };
      return app.out.working(`Checking ${workspace.store}`, () =>
        gatherFacts(app, prepared, offline),
      );
    },
  );

  const requested = offline ?? {
    target: await promptForTarget(app, workspace, list),
    origin: 'prompt' as const,
  };
  const plan = planPush({
    ...planBase(prepared),
    authentication: describeAuthentication(prepared, storeAuth),
    requested,
    themes: list,
    developmentThemeId,
  });

  const request = invocation(prepared, 'push', flags.without([...CONTEXT_FLAGS, ...TARGET_FLAGS]), {
    target: plan.target,
  });
  if (options.dryRun === true && flags.has('json')) {
    app.out.json({ ...planJson(plan), command: ['shopify', ...buildThemeArgs(request)] });
    return;
  }
  printPlan(app, plan, storeAuth);
  if (options.dryRun === true) return reportDryRun(app, prepared, request);

  await confirmPush(app, plan, prepared, options);
  await app.workspaces.touch(workspace.id);
  finish(await launch(app, prepared, request));
}

function planBase({ workspace, account, guard }: Prepared) {
  return {
    workspace,
    account,
    authentication: account.alias,
    store: workspace.store,
    directory: guard.themeDirectory,
    environment: guard.environment?.name,
  };
}

async function gatherFacts(app: App, prepared: Prepared, requested: ResolvedTarget | undefined) {
  const list = await fetchThemes(app, prepared);
  // Sequential on purpose: overlapping Shopify CLI processes can lose each other's refreshed tokens.
  const needsDevelopment =
    requested === undefined ||
    (requested.target.kind === 'development' && requested.target.context === undefined);
  const developmentThemeId = needsDevelopment
    ? await app.shopify.developmentThemeId(storeContext(prepared))
    : undefined;
  const stores = prepared.useThemeToken ? [] : await app.shopify.storesWithStoreAuth();
  return { list, developmentThemeId, storeAuth: stores.includes(prepared.workspace.store) };
}

async function fetchThemes(app: App, prepared: Prepared): Promise<RemoteTheme[]> {
  const ticket = await app.gate.enter(prepared.workspace.id);
  try {
    return await app.shopify.listThemes(storeContext(prepared));
  } finally {
    ticket.release();
  }
}

async function promptForTarget(
  app: App,
  workspace: Workspace,
  list: readonly RemoteTheme[],
): Promise<ThemeTarget> {
  const order = ['unpublished', 'live', 'main'];
  const choices = list
    .filter((theme) => theme.role !== 'development')
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
    .map((theme) => ({
      value: theme.id,
      label: theme.name,
      hint: isLive(theme) ? `LIVE · #${theme.id}` : `${theme.role} · #${theme.id}`,
    }));
  const answer = await app.prompts.select(
    `Push to which theme on ${workspace.store}?`,
    [
      { value: 'development', label: 'Your development theme', hint: 'only you can see it' },
      ...choices,
      { value: 'unpublished', label: '+ New unpublished theme' },
    ],
    { alternative: 'shopshift push --theme <id>' },
  );
  if (answer === 'development') return { kind: 'development' };
  if (answer === 'unpublished') {
    const name = await app.prompts.text('Name of the new theme', {
      alternative: 'shopshift push --unpublished --theme <name>',
    });
    return { kind: 'unpublished', name };
  }
  return { kind: 'theme', ref: answer };
}

function describeAuthentication({ account, useThemeToken }: Prepared, storeAuth: boolean): string {
  if (useThemeToken) return 'theme token';
  return storeAuth
    ? `${account.alias}, or the store's own "shopify store auth" session`
    : account.alias;
}

function printPlan(app: App, plan: PushPlan, storeAuth: boolean): void {
  const { note } = app.out;
  const badge = plan.live ? `${note.live(' LIVE ')} ` : '';
  const theme =
    plan.theme === undefined
      ? plan.target.kind === 'unpublished'
        ? `New unpublished theme${plan.target.name === undefined ? '' : ` "${plan.target.name}"`}`
        : `Development theme${plan.target.kind === 'development' && plan.target.context !== undefined ? ` (${plan.target.context})` : ', created if needed'}`
      : `${badge}${plan.theme.name} ${note.dim(`#${plan.theme.id}, ${plan.theme.role}`)}`;
  const account =
    plan.authentication === 'theme token'
      ? 'Theme token (the workspace account is not used)'
      : `${plan.account.name} ${note.dim(plan.account.alias)}`;
  const rows: [string, string][] = [
    ['Workspace', note.bold(plan.workspace.name)],
    ['Account', account],
    ['Store', note.bold(plan.store)],
    ['Theme', theme],
    ['Directory', displayPath(plan.directory)],
  ];
  if (plan.environment !== undefined) rows.push(['Environment', plan.environment]);

  app.out.say();
  app.out.say(`  ${note.bold('Push')}`);
  app.out.say();
  for (const line of fields(rows, note)) app.out.say(line);
  app.out.say();
  if (storeAuth) {
    app.out.warn(
      'This store has a "shopify store auth" session. If it has theme access, Shopify CLI will push with that instead.',
    );
  }
}

async function confirmPush(
  app: App,
  plan: PushPlan,
  prepared: Prepared,
  options: ThemeOptions,
): Promise<void> {
  const decision = decideConfirmation(plan, {
    interactive: prepared.interactive,
    yes: options.yes === true,
    confirmLive: options.confirmLive,
    allowLive: prepared.flags.has('allow-live'),
  });
  if (decision === 'proceed') return;
  if (decision === 'ask') {
    const what = plan.theme === undefined ? 'a new theme' : `"${plan.theme.name}"`;
    const confirmed = await app.prompts.confirm(
      `Overwrite ${what} on ${storeHandle(plan.store)}?`,
      { alternative: 'Add --yes.' },
    );
    if (!confirmed) throw new ShopShiftError('CANCELLED', 'Nothing was pushed.');
    return;
  }
  app.out.say(
    `${app.out.note.danger(symbols.warning)} ${plan.live ? 'Customers will see this change immediately.' : `The role "${plan.theme?.role}" is unknown, so this is treated as a live theme.`}`,
  );
  await typeStoreName(
    app,
    plan.workspace,
    `Type ${storeHandle(plan.store)} to push to the live theme`,
  );
}

async function typeStoreName(app: App, workspace: Workspace, message: string): Promise<void> {
  const expected = storeHandle(workspace.store);
  await app.prompts.text(message, {
    alternative: 'Add --allow-live --confirm-live <theme-id>.',
    check: (value) => {
      if (value !== expected && value !== workspace.store)
        throw new Error(`Type ${expected}, or press Esc to cancel`);
    },
  });
}

function planJson(plan: PushPlan) {
  return {
    workspace: plan.workspace.id,
    account: plan.account.id,
    alias: plan.account.alias,
    store: plan.store,
    directory: plan.directory,
    environment: plan.environment ?? null,
    target: plan.target,
    origin: plan.origin,
    theme: plan.theme ?? null,
    live: plan.live,
    confirmation: plan.confirmation,
  };
}

function stringSetting(guard: GuardResult, key: string): string | undefined {
  const value = guard.environment?.settings[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? String(value)
    : undefined;
}
