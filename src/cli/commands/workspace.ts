import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAccount } from '../../core/accounts.js';
import type { Config, Workspace } from '../../core/config/schema.js';
import { noWorkspace, selectWorkspace } from '../../core/detection.js';
import { findEnvironmentConflicts } from '../../core/environment.js';
import { ShopShiftError } from '../../core/errors.js';
import { displayPath, isDirectory, resolveDirectory } from '../../core/paths.js';
import { DEFAULT_DEV_PORT, findFreePort } from '../../core/ports.js';
import type { DevSession } from '../../core/sessions.js';
import { findThemeConfig, readThemeEnvironments } from '../../core/theme-config.js';
import {
  normalizeStore,
  slugify,
  storeHandle,
  validateName,
  validatePort,
  validateThemeId,
} from '../../core/validate.js';
import { getWorkspace, listWorkspaces, type WorkspacePatch } from '../../core/workspaces.js';
import { columnWidth, fields, pad, relativeTime } from '../../ui/output.js';
import { symbols } from '../../ui/style.js';
import type { App } from '../app.js';
import { chooseWorkspace, referenceOrPrompt } from '../select.js';
import { chooseOrAddAccount } from './account.js';

export interface AddOptions {
  account?: string;
  store?: string;
  dir?: string;
  theme?: string;
  environment?: string;
  port?: string;
}

/** Non-interactive when a name, a store and an account are known; otherwise a wizard asks for the rest. */
export async function add(
  app: App,
  name: string | undefined,
  options: AddOptions,
): Promise<Workspace> {
  const config = app.store.read();
  const account = options.account ?? (app.prompts.interactive ? undefined : config.defaultAccount);
  if (name !== undefined && options.store !== undefined && account !== undefined) {
    const workspace = await app.workspaces.add({
      name,
      account,
      store: options.store,
      directory: options.dir ?? app.cwd,
      themeId: options.theme,
      environment: options.environment,
      port: options.port,
    });
    reportAdded(app, workspace);
    return workspace;
  }
  if (!app.prompts.interactive) {
    throw new ShopShiftError('INTERACTIVE_REQUIRED', 'Not enough information to add a workspace.', {
      hint: 'shopshift add <name> --store <store> --account <account> [--dir <path>]',
    });
  }
  return wizard(app, name, options);
}

async function wizard(app: App, name: string | undefined, options: AddOptions): Promise<Workspace> {
  const alternative = 'shopshift add <name> --store <store> --account <account>';
  app.prompts.intro(app.out.note.bold('New workspace'));

  const directory = resolveDirectory(
    options.dir ??
      (await app.prompts.text('Project directory', {
        initial: displayPath(app.cwd),
        alternative,
        check: (value) => resolveDirectory(value, app.cwd),
      })),
    app.cwd,
  );
  const suggestedName = titleCase(path.basename(directory));
  const chosenName =
    name ??
    (await app.prompts.text('Workspace name', {
      initial: suggestedName,
      alternative,
      check: (value) => assertNameFree(app.store.read(), value),
    }));
  assertNameFree(app.store.read(), chosenName);

  const account =
    options.account === undefined
      ? await chooseOrAddAccount(app)
      : getAccount(app.store.read(), options.account);

  const detected = detectEnvironments(directory);
  const store = normalizeStore(
    options.store ??
      (await app.prompts.text('Store', {
        placeholder: 'your-store.myshopify.com',
        initial: detected.store === undefined ? undefined : storeHandle(detected.store),
        alternative,
        check: normalizeStore,
      })),
  );

  const environment =
    options.environment ?? (await chooseEnvironment(app, detected.names, alternative));
  const theme =
    options.theme ??
    (await app.prompts.text('Default theme ID for push and pull (optional)', {
      placeholder: 'Leave empty to choose each time',
      optional: true,
      alternative,
      check: validateThemeId,
    }));
  const reserved = new Set(
    listWorkspaces(app.store.read()).flatMap((workspace) => workspace.port ?? []),
  );
  const suggestedPort = await findFreePort(DEFAULT_DEV_PORT, reserved);
  const port =
    options.port ??
    (await app.prompts.text('Development port', {
      initial: suggestedPort === undefined ? undefined : String(suggestedPort),
      optional: true,
      alternative,
      check: validatePort,
    }));

  const workspace = await app.workspaces.add({
    name: chosenName,
    account: account.id,
    store,
    directory,
    themeId: theme === '' ? undefined : theme,
    environment: environment === '' ? undefined : environment,
    port: port === '' ? undefined : port,
  });
  app.prompts.outro(`${app.out.note.success(symbols.success)} ${workspace.name} is ready`);
  app.out.info(`  cd ${displayPath(workspace.directory)} && shopshift dev`);
  return workspace;
}

function detectEnvironments(directory: string): { names: string[]; store: string | undefined } {
  const file = findThemeConfig(directory);
  if (file === undefined) return { names: [], store: undefined };
  try {
    const environments = readThemeEnvironments(file);
    const candidate = environments.default?.store;
    return {
      names: Object.keys(environments),
      store: typeof candidate === 'string' ? normalizeStore(candidate) : undefined,
    };
  } catch {
    return { names: [], store: undefined };
  }
}

async function chooseEnvironment(
  app: App,
  names: readonly string[],
  alternative: string,
): Promise<string> {
  if (names.length === 0) return '';
  return app.prompts.select(
    'Shopify environment (from shopify.theme.toml)',
    [{ value: '', label: 'None' }, ...names.map((item) => ({ value: item, label: item }))],
    { alternative },
  );
}

function assertNameFree(config: Config, name: string): void {
  const id = slugify(validateName(name, 'Workspace name'));
  if (Object.hasOwn(config.workspaces, id)) {
    throw new ShopShiftError('WORKSPACE_EXISTS', `A workspace called "${id}" already exists.`);
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function reportAdded(app: App, workspace: Workspace): void {
  app.out.success(`Added ${app.out.note.bold(workspace.name)} (${workspace.store})`);
}

export interface EditOptions {
  name?: string;
  account?: string;
  store?: string;
  dir?: string;
  theme?: string | false;
  environment?: string | false;
  port?: string | false;
}

export async function edit(
  app: App,
  reference: string | undefined,
  options: EditOptions,
): Promise<void> {
  const config = app.store.read();
  const id = await referenceOrPrompt(
    app,
    config,
    reference,
    'Edit which workspace?',
    'shopshift edit <workspace> [options]',
  );
  const workspace = getWorkspace(config, id);
  const patch = patchFromOptions(options);
  const updated = await app.workspaces.edit(
    workspace.id,
    Object.keys(patch).length > 0 ? patch : await editInteractively(app, workspace),
  );
  if (
    workspace.store !== updated.store &&
    workspace.themeId !== undefined &&
    updated.themeId === undefined
  ) {
    app.out.warn('The default theme was cleared, because it belonged to the previous store.');
  }
  app.out.success(`Saved ${app.out.note.bold(updated.name)}`);
  for (const line of describeWorkspace(app, app.store.read(), updated)) app.out.say(line);
}

function patchFromOptions(options: EditOptions): WorkspacePatch {
  const clearable = (value: string | false | undefined) => (value === false ? null : value);
  return Object.fromEntries(
    Object.entries({
      name: options.name,
      account: options.account,
      store: options.store,
      directory: options.dir,
      themeId: clearable(options.theme),
      environment: clearable(options.environment),
      port: clearable(options.port),
    }).filter(([, value]) => value !== undefined),
  );
}

async function editInteractively(app: App, workspace: Workspace): Promise<WorkspacePatch> {
  const alternative = `shopshift edit ${workspace.id} --store <store> (see --help)`;
  const field = await app.prompts.select(
    `Edit ${workspace.name}`,
    [
      { value: 'name', label: 'Name', hint: workspace.name },
      { value: 'account', label: 'Account', hint: workspace.account },
      { value: 'store', label: 'Store', hint: workspace.store },
      { value: 'directory', label: 'Directory', hint: displayPath(workspace.directory) },
      { value: 'themeId', label: 'Default theme', hint: workspace.themeId ?? 'none' },
      { value: 'environment', label: 'Environment', hint: workspace.environment ?? 'none' },
      {
        value: 'port',
        label: 'Development port',
        hint: workspace.port === undefined ? 'automatic' : String(workspace.port),
      },
    ],
    { alternative },
  );
  switch (field) {
    case 'account':
      return { account: (await chooseOrAddAccount(app, workspace.account)).id };
    case 'themeId':
    case 'environment':
    case 'port': {
      const current = workspace[field];
      const answer = await app.prompts.text('New value (empty to clear)', {
        initial: current === undefined ? undefined : String(current),
        optional: true,
        alternative,
        ...(field === 'port'
          ? { check: validatePort }
          : field === 'themeId'
            ? { check: validateThemeId }
            : {}),
      });
      return { [field]: answer === '' ? null : answer };
    }
    default: {
      const current =
        field === 'directory'
          ? displayPath(workspace.directory)
          : workspace[field as 'name' | 'store'];
      const check =
        field === 'store'
          ? normalizeStore
          : field === 'directory'
            ? (value: string) => resolveDirectory(value, app.cwd)
            : validateName;
      return {
        [field]: await app.prompts.text('New value', { initial: current, alternative, check }),
      };
    }
  }
}

export async function remove(
  app: App,
  reference: string | undefined,
  options: { yes?: boolean },
): Promise<void> {
  const config = app.store.read();
  const id = await referenceOrPrompt(
    app,
    config,
    reference,
    'Remove which workspace?',
    'shopshift remove <workspace> --yes',
  );
  const workspace = getWorkspace(config, id);
  const running = app.sessions.list().find((session) => session.workspace === workspace.id);
  if (running !== undefined) {
    throw new ShopShiftError(
      'SESSION_CONFLICT',
      `"${workspace.name}" has a development server running on port ${running.port}.`,
      {
        hint: 'Stop it first.',
      },
    );
  }
  if (options.yes !== true) {
    const confirmed = await app.prompts.confirm(
      `Forget "${workspace.name}" (${workspace.store})?`,
      {
        alternative: `shopshift remove ${workspace.id} --yes`,
      },
    );
    if (!confirmed) throw new ShopShiftError('CANCELLED', 'Nothing was removed.');
  }
  await app.workspaces.remove(workspace.id);
  app.out.success(`Removed ${workspace.name}`);
  app.out.info('  Your files and the store were not touched.');
}

export async function use(app: App, reference: string | undefined): Promise<Workspace> {
  const config = app.store.read();
  const id = await referenceOrPrompt(
    app,
    config,
    reference,
    'Switch to which workspace?',
    'shopshift use <workspace>',
  );
  const workspace = await app.workspaces.use(id);
  announce(app, workspace);
  return workspace;
}

/** Prints the new context, and tells the shell integration where to go. */
export function announce(app: App, workspace: Workspace): void {
  const config = app.store.read();
  app.out.success(`Switched to ${app.out.note.bold(workspace.name)}`);
  for (const line of describeWorkspace(app, config, workspace)) app.out.say(line);

  const cdFile = app.env.SHOPSHIFT_CD_FILE;
  if (cdFile !== undefined && cdFile !== '' && isDirectory(workspace.directory)) {
    writeFileSync(cdFile, workspace.directory, { flag: 'r+' });
  }
}

export function list(app: App, options: { json?: boolean }): void {
  const config = app.store.read();
  const workspaces = listWorkspaces(config);
  const running = new Map(app.sessions.list().map((session) => [session.workspace, session]));
  const selection = selectWorkspace(config, app.cwd);
  const current = selection.kind === 'selected' ? selection.workspace.id : undefined;

  if (options.json === true) {
    app.out.json({
      workspaces: workspaces.map((workspace) => ({
        ...publicWorkspace(config, workspace),
        active: workspace.id === config.activeWorkspace,
        current: workspace.id === current,
        running: running.get(workspace.id)?.port ?? null,
      })),
    });
    return;
  }
  if (workspaces.length === 0) {
    app.out.say('No workspaces yet. Create one with: shopshift add');
    return;
  }
  const { style } = app.out;
  const rows = workspaces.map((workspace) => ({
    workspace,
    account: config.accounts[workspace.account]?.name ?? `${workspace.account}?`,
    environment: workspace.environment ?? '',
  }));
  const widths = {
    name: columnWidth(rows.map((row) => row.workspace.name)) + 3,
    store: columnWidth(rows.map((row) => storeHandle(row.workspace.store))) + 3,
    account: columnWidth(rows.map((row) => row.account)) + 3,
    environment: columnWidth(rows.map((row) => row.environment)) + 3,
  };
  app.out.print();
  for (const { workspace, account, environment } of rows) {
    const marker =
      workspace.id === current ? style.accent(symbols.active) : style.dim(symbols.inactive);
    const session = running.get(workspace.id);
    const state =
      session === undefined
        ? isDirectory(workspace.directory)
          ? style.dim(relativeTime(workspace.lastUsedAt))
          : style.danger('directory missing')
        : style.success(`running on ${session.port}`);
    app.out.print(
      `  ${marker} ${style.bold(pad(workspace.name, widths.name))}${pad(storeHandle(workspace.store), widths.store)}${style.dim(pad(account, widths.account))}${environment === '' && widths.environment === 3 ? '' : style.dim(pad(environment, widths.environment))}${state}`,
    );
  }
  app.out.print();
}

export function current(app: App, options: { json?: boolean; field?: string }): void {
  const config = app.store.read();
  const selection = selectWorkspace(config, app.cwd);
  if (selection.kind === 'ambiguous') {
    throw new ShopShiftError(
      'WORKSPACE_AMBIGUOUS',
      `${selection.candidates.length} workspaces use this directory.`,
      {
        details: selection.candidates.map((candidate) => `${candidate.id} → ${candidate.store}`),
        hint: 'Choose one with: shopshift use <workspace>',
      },
    );
  }
  if (selection.kind === 'none') throw noWorkspace(config);
  const { workspace, source } = selection;
  const data = { ...publicWorkspace(config, workspace), source };

  if (options.field !== undefined) {
    const value = Object.hasOwn(data, options.field)
      ? data[options.field as keyof typeof data]
      : undefined;
    if (value === undefined || value === null) {
      throw new ShopShiftError('USAGE', `The workspace has no "${options.field}".`, {
        hint: `Available: ${Object.entries(data)
          .filter(([, item]) => item !== null)
          .map(([key]) => key)
          .join(', ')}`,
      });
    }
    app.out.print(String(value));
  } else if (options.json === true) {
    app.out.json(data);
  } else {
    const { style } = app.out;
    app.out.print(`${style.bold(workspace.name)}  ${workspace.store}  ${style.dim(data.account)}`);
  }
}

export async function status(
  app: App,
  options: { json?: boolean; workspace?: string; check?: boolean },
): Promise<void> {
  const config = app.store.read();
  const running = app.sessions.list();
  if (Object.keys(config.workspaces).length === 0) {
    if (options.json === true) app.out.json({ workspace: null, running });
    else app.out.say('No workspaces yet. Get started with: shopshift init');
    return;
  }
  const { workspace, source } = await chooseWorkspace(app, config, 'status', options.workspace);
  const account = config.accounts[workspace.account];
  const session =
    options.check === true && account !== undefined
      ? await app.out.working('Checking the Shopify session', () =>
          app.shopify.aliasStatus(account.alias).catch(() => 'unknown' as const),
        )
      : undefined;
  const conflicts = findEnvironmentConflicts(app.env, {
    store: workspace.store,
    alias: account?.alias,
  });

  if (options.json === true) {
    app.out.json({
      workspace: { ...publicWorkspace(config, workspace), source },
      ...(session === undefined ? {} : { session }),
      conflicts: conflicts.map(({ variable, kind }) => ({ variable, kind })),
      running,
    });
    return;
  }
  const { style } = app.out;
  app.out.print();
  app.out.print(`  ${style.bold(workspace.name)}  ${style.dim(explainSource(source))}`);
  app.out.print();
  for (const line of describeWorkspace(app, config, workspace, 'stdout')) app.out.print(line);
  if (session !== undefined) {
    const label =
      session === 'available'
        ? style.success('signed in')
        : style.danger(session === 'missing' ? 'signed out' : 'unknown');
    for (const line of fields([['Session  ', label]], style)) app.out.print(line);
  }
  printRunning(app, config, running);
  if (conflicts.length > 0) {
    app.out.print();
    for (const conflict of conflicts) {
      app.out.print(
        `  ${style.warning(symbols.warning)} ${conflict.variable} ${conflict.description}`,
      );
    }
  }
  app.out.print();
}

function printRunning(app: App, config: Config, running: readonly DevSession[]): void {
  if (running.length === 0) return;
  const { style } = app.out;
  app.out.print();
  app.out.print(`  ${style.bold('Running')}`);
  const width =
    columnWidth(
      running.map((session) => config.workspaces[session.workspace]?.name ?? session.workspace),
    ) + 3;
  for (const session of running) {
    const name = config.workspaces[session.workspace]?.name ?? session.workspace;
    app.out.print(
      `  ${style.success(symbols.active)} ${pad(name, width)}http://127.0.0.1:${session.port}  ${style.dim(`${storeHandle(session.store)}, ${relativeTime(session.startedAt)}`)}`,
    );
  }
}

function explainSource(source: string): string {
  switch (source) {
    case 'directory':
      return 'from this directory';
    case 'shared-directory':
      return 'active, one of several for this directory';
    case 'active':
      return 'active, not inside its directory';
    default:
      return '';
  }
}

export function describeWorkspace(
  app: App,
  config: Config,
  workspace: Workspace,
  stream: 'stdout' | 'stderr' = 'stderr',
): string[] {
  const style = stream === 'stdout' ? app.out.style : app.out.note;
  const account = config.accounts[workspace.account];
  const rows: [string, string][] = [
    [
      'Account',
      account === undefined
        ? style.danger(`${workspace.account} (missing)`)
        : `${account.name} ${style.dim(account.alias)}`,
    ],
    ['Store', workspace.store],
    [
      'Directory',
      isDirectory(workspace.directory)
        ? displayPath(workspace.directory)
        : style.danger(`${displayPath(workspace.directory)} (missing)`),
    ],
  ];
  if (workspace.themeId !== undefined) rows.push(['Theme', `#${workspace.themeId}`]);
  if (workspace.environment !== undefined) rows.push(['Environment', workspace.environment]);
  if (workspace.port !== undefined) rows.push(['Port', String(workspace.port)]);
  return fields(rows, style);
}

/** The documented JSON shape. Optional fields are null rather than absent. */
function publicWorkspace(config: Config, workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    account: workspace.account,
    alias: config.accounts[workspace.account]?.alias ?? null,
    store: workspace.store,
    directory: workspace.directory,
    themeId: workspace.themeId ?? null,
    environment: workspace.environment ?? null,
    port: workspace.port ?? null,
    lastUsedAt: workspace.lastUsedAt ?? null,
  };
}
