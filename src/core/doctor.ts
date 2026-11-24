import path from 'node:path';
import { listAccounts } from './accounts.js';
import { type Config, emptyConfig, findIntegrityIssues, type Workspace } from './config/schema.js';
import type { ConfigStore } from './config/store.js';
import { findEnvironmentConflicts, presentCredentialVariables } from './environment.js';
import { ShopShiftError } from './errors.js';
import { displayPath, type Env, isDirectory } from './paths.js';
import { DEFAULT_DEV_PORT, isPortFree } from './ports.js';
import type { SessionRegistry } from './sessions.js';
import type { ShopifyCli } from './shopify/client.js';
import { INSTALL_HINT } from './shopify/locate.js';
import {
  classifyVersion,
  compareVersions,
  MINIMUM_SHOPIFY_CLI,
  TESTED_SHOPIFY_CLI_MAJOR,
} from './shopify/version.js';
import { resolveThemeEnvironment } from './theme-config.js';
import { listWorkspaces } from './workspaces.js';

export const MINIMUM_NODE = '22.12.0';
const THEME_DIRECTORIES = ['config', 'layout', 'templates'];

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  group: 'System' | 'Configuration' | 'Accounts' | 'Workspaces' | 'Environment';
  status: CheckStatus;
  title: string;
  detail?: string;
  fix?: string;
}

export interface DoctorDependencies {
  store: ConfigStore;
  shopify: ShopifyCli;
  sessions: SessionRegistry;
  env: Env;
  nodeVersion: string;
}

/** Runs every check. A failing check never stops the others, and no check prints a credential. */
export async function runDoctor(dependencies: DoctorDependencies): Promise<CheckResult[]> {
  const results: CheckResult[] = [checkNode(dependencies.nodeVersion)];
  const shopifyResults = await checkShopify(dependencies.shopify);
  results.push(...shopifyResults);
  const shopifyUsable = shopifyResults.every((result) => result.status !== 'fail');

  const { config, results: configResults } = checkConfig(dependencies.store);
  results.push(...configResults);
  results.push(...(await checkAccounts(config, dependencies.shopify, shopifyUsable)));
  results.push(...(await checkWorkspaces(config, dependencies)));
  results.push(...checkEnvironment(dependencies.env));
  if (shopifyUsable) results.push(...(await checkStoreAuth(config, dependencies.shopify)));
  return results;
}

function checkNode(version: string): CheckResult {
  const clean = version.replace(/^v/, '');
  const ok = compareVersions(clean, MINIMUM_NODE) >= 0;
  return {
    id: 'node',
    group: 'System',
    status: ok ? 'ok' : 'fail',
    title: `Node.js ${clean}`,
    ...(ok
      ? {}
      : {
          detail: `Version ${MINIMUM_NODE} or newer is required.`,
          fix: 'Install a current LTS release from https://nodejs.org',
        }),
  };
}

async function checkShopify(shopify: ShopifyCli): Promise<CheckResult[]> {
  let executable: string;
  try {
    executable = shopify.executable().path;
  } catch (error) {
    return [
      {
        id: 'shopify-cli',
        group: 'System',
        status: 'fail',
        title: 'Shopify CLI not found',
        ...(error instanceof ShopShiftError
          ? { detail: error.message, fix: error.hint ?? INSTALL_HINT }
          : { fix: INSTALL_HINT }),
      },
    ];
  }

  const version = await shopify.version({ fresh: true }).catch(() => undefined);
  const base = { id: 'shopify-cli', group: 'System' as const, detail: displayPath(executable) };
  switch (classifyVersion(version)) {
    case 'supported':
      return [{ ...base, status: 'ok', title: `Shopify CLI ${version}` }];
    case 'untested':
      return [
        {
          ...base,
          status: 'warn',
          title: `Shopify CLI ${version} has not been tested`,
          detail: `ShopShift has been tested up to version ${TESTED_SHOPIFY_CLI_MAJOR}.x.`,
          fix: 'Check for a newer ShopShift: npm install -g shopshift@latest',
        },
      ];
    case 'too-old':
      return [
        {
          ...base,
          status: 'fail',
          title: `Shopify CLI ${version} is too old`,
          detail: `Version ${MINIMUM_SHOPIFY_CLI} or newer is required.`,
          fix: 'npm install -g @shopify/cli@latest',
        },
      ];
    default:
      return [
        {
          ...base,
          status: 'fail',
          title: 'Shopify CLI did not report a version',
          fix: 'Run "shopify version" to see why, then reinstall it if needed.',
        },
      ];
  }
}

function checkConfig(store: ConfigStore): { config: Config; results: CheckResult[] } {
  const base = { id: 'config', group: 'Configuration' as const };
  if (!store.exists()) {
    return {
      config: emptyConfig(),
      results: [{ ...base, status: 'warn', title: 'Not set up yet', fix: 'shopshift init' }],
    };
  }
  let config: Config;
  try {
    config = store.read();
  } catch (error) {
    if (!(error instanceof ShopShiftError)) throw error;
    return {
      config: emptyConfig(),
      results: [
        {
          ...base,
          status: 'fail',
          title: error.message,
          ...(error.details.length === 0 ? {} : { detail: error.details.join('\n') }),
          ...(error.hint === undefined ? {} : { fix: error.hint }),
        },
      ],
    };
  }
  const issues = findIntegrityIssues(config);
  return {
    config,
    results: [
      {
        ...base,
        status: 'ok',
        title: `${count(Object.keys(config.workspaces).length, 'workspace')}, ${count(Object.keys(config.accounts).length, 'account')}`,
        detail: displayPath(store.paths.configFile),
      },
      ...issues.map(
        (issue, index): CheckResult => ({
          id: `integrity-${index + 1}`,
          group: 'Configuration',
          status: issue.workspace === undefined ? 'warn' : 'fail',
          title: issue.message,
          fix: issue.fix,
        }),
      ),
    ],
  };
}

async function checkAccounts(
  config: Config,
  shopify: ShopifyCli,
  usable: boolean,
): Promise<CheckResult[]> {
  const accounts = listAccounts(config);
  if (accounts.length === 0 || !usable) return [];
  const results: CheckResult[] = [];
  // One at a time: overlapping Shopify CLI starts are exactly what ShopShift avoids elsewhere.
  for (const account of accounts) {
    const base = { id: `account-${account.id}`, group: 'Accounts' as const };
    try {
      const status = await shopify.aliasStatus(account.alias);
      results.push(
        status === 'available'
          ? {
              ...base,
              status: 'ok',
              title: account.name,
              detail: `Shopify CLI has a session for ${account.alias}`,
            }
          : {
              ...base,
              status: 'fail',
              title: account.name,
              detail: `Shopify CLI has no session for ${account.alias}`,
              fix: `shopshift account login ${account.id}`,
            },
      );
    } catch {
      results.push({
        ...base,
        status: 'warn',
        title: account.name,
        detail: 'The session could not be checked.',
        fix: `shopshift account login ${account.id}`,
      });
    }
  }
  return results;
}

async function checkWorkspaces(
  config: Config,
  { sessions }: DoctorDependencies,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const running = new Map(sessions.list().map((session) => [session.port, session]));
  const byPort = new Map<number, Workspace[]>();

  for (const workspace of listWorkspaces(config)) {
    const problems: { detail: string; fix: string; status: CheckStatus }[] = [];

    if (!isDirectory(workspace.directory)) {
      problems.push({
        status: 'fail',
        detail: `${displayPath(workspace.directory)} does not exist.`,
        fix: `shopshift edit ${workspace.id} --dir <path>`,
      });
    } else {
      const environment = inspectEnvironment(workspace);
      if (environment.problem !== undefined) problems.push(environment.problem);
      const root = path.resolve(workspace.directory, environment.path ?? '.');
      const missing = THEME_DIRECTORIES.filter((name) => !isDirectory(path.join(root, name)));
      if (missing.length > 0) {
        problems.push({
          status: 'warn',
          detail: `${displayPath(root)} does not look like a theme (no ${missing.join(', ')}).`,
          fix: 'Run "shopshift pull" to download a theme, or correct the directory.',
        });
      }
    }

    if (workspace.port !== undefined) {
      byPort.set(workspace.port, [...(byPort.get(workspace.port) ?? []), workspace]);
      const session = running.get(workspace.port);
      if (session?.workspace !== workspace.id && !(await isPortFree(workspace.port))) {
        problems.push({
          status: 'warn',
          detail: `Port ${workspace.port} is in use${session === undefined ? '' : ` by the workspace "${session.workspace}"`}.`,
          fix: `Stop what is using it, or: shopshift edit ${workspace.id} --port <port>`,
        });
      }
    }

    const worst = problems.some((problem) => problem.status === 'fail') ? 'fail' : 'warn';
    results.push(
      problems.length === 0
        ? {
            id: `workspace-${workspace.id}`,
            group: 'Workspaces',
            status: 'ok',
            title: workspace.name,
            detail: workspace.store,
          }
        : {
            id: `workspace-${workspace.id}`,
            group: 'Workspaces',
            status: worst,
            title: workspace.name,
            detail: problems.map((problem) => problem.detail).join('\n'),
            fix: problems.map((problem) => problem.fix).join('\n'),
          },
    );
  }

  for (const [port, workspaces] of byPort) {
    if (workspaces.length < 2) continue;
    results.push({
      id: `port-${port}`,
      group: 'Workspaces',
      status: 'warn',
      title: `Port ${port} is shared by ${workspaces.map((workspace) => workspace.name).join(' and ')}`,
      detail: 'They cannot run at the same time.',
      fix: `shopshift edit ${workspaces[1]?.id} --port <port>`,
    });
  }

  const unassigned = listWorkspaces(config).some((workspace) => workspace.port === undefined);
  if (unassigned && !running.has(DEFAULT_DEV_PORT) && !(await isPortFree(DEFAULT_DEV_PORT))) {
    results.push({
      id: 'default-port',
      group: 'Workspaces',
      status: 'warn',
      title: `The default port ${DEFAULT_DEV_PORT} is in use`,
      detail: 'Workspaces without a preferred port will use the next free one.',
    });
  }
  return results;
}

function inspectEnvironment(workspace: Workspace): {
  path?: string;
  problem?: { status: CheckStatus; detail: string; fix: string };
} {
  try {
    const environment = resolveThemeEnvironment(workspace.directory, workspace.environment);
    const custom = environment?.settings.path;
    return typeof custom === 'string' ? { path: custom } : {};
  } catch (error) {
    if (!(error instanceof ShopShiftError)) throw error;
    return {
      problem: {
        status: 'fail',
        detail: error.message,
        fix: error.hint ?? `shopshift edit ${workspace.id} --no-environment`,
      },
    };
  }
}

function checkEnvironment(env: Env): CheckResult[] {
  const credentials = new Set(presentCredentialVariables(env));
  const conflicts = findEnvironmentConflicts(env, {});
  if (conflicts.length === 0) {
    return [
      {
        id: 'environment',
        group: 'Environment',
        status: 'ok',
        title: 'No conflicting environment variables',
      },
    ];
  }
  return conflicts.map(
    (conflict): CheckResult => ({
      id: `env-${conflict.variable}`,
      group: 'Environment',
      status: 'warn',
      title: `${conflict.variable} is set`,
      // Only the name is ever shown for credentials.
      detail: credentials.has(conflict.variable)
        ? 'It overrides the workspace account. ShopShift removes it from commands, and blocks pushes while it is set.'
        : 'It can change which store or theme is used. ShopShift removes it from commands, and blocks pushes while it contradicts the workspace.',
      fix: `unset ${conflict.variable}`,
    }),
  );
}

async function checkStoreAuth(config: Config, shopify: ShopifyCli): Promise<CheckResult[]> {
  const stores = new Set(await shopify.storesWithStoreAuth().catch(() => []));
  return listWorkspaces(config)
    .filter((workspace) => stores.has(workspace.store))
    .map(
      (workspace): CheckResult => ({
        id: `store-auth-${workspace.id}`,
        group: 'Environment',
        status: 'warn',
        title: `${workspace.store} has a "shopify store auth" session`,
        detail:
          'If it has theme access, Shopify CLI uses it for push and pull instead of the workspace account.',
      }),
    );
}

function count(total: number, noun: string): string {
  return `${total} ${noun}${total === 1 ? '' : 's'}`;
}
