import { AccountManager } from '../core/accounts.js';
import { ConfigStore } from '../core/config/store.js';
import { LaunchGate } from '../core/launch-gate.js';
import { type Env, resolvePaths, type ShopShiftPaths } from '../core/paths.js';
import { SessionRegistry } from '../core/sessions.js';
import { ShopifyCli } from '../core/shopify/client.js';
import { WorkspaceManager } from '../core/workspaces.js';
import { Output } from '../ui/output.js';
import { Prompts } from '../ui/prompts.js';

/** Everything a command needs, assembled once per process. */
export interface App {
  env: Env;
  cwd: string;
  paths: ShopShiftPaths;
  store: ConfigStore;
  accounts: AccountManager;
  workspaces: WorkspaceManager;
  shopify: ShopifyCli;
  sessions: SessionRegistry;
  gate: LaunchGate;
  out: Output;
  prompts: Prompts;
}

export function createApp(): App {
  const env: Env = process.env;
  const paths = resolvePaths(env);
  const store = new ConfigStore(paths);
  return {
    env,
    cwd: process.cwd(),
    paths,
    store,
    accounts: new AccountManager(store),
    workspaces: new WorkspaceManager(store),
    shopify: new ShopifyCli(paths, env),
    sessions: new SessionRegistry(paths),
    gate: new LaunchGate(paths),
    out: new Output(),
    prompts: new Prompts(isInteractive(env)),
  };
}

function isInteractive(env: Env): boolean {
  if (env.SHOPSHIFT_NO_INPUT || env.SHOPIFY_FLAG_NO_INPUT) return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  return process.stdin.isTTY === true && process.stderr.isTTY === true;
}
