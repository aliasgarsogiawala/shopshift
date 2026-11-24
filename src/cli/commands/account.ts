import {
  findAccount,
  getAccount,
  listAccounts,
  workspacesUsingAccount,
} from '../../core/accounts.js';
import type { Account, Config } from '../../core/config/schema.js';
import { ShopShiftError } from '../../core/errors.js';
import { isProcessAlive } from '../../core/fs/lock.js';
import { slugify, validateAlias, validateName } from '../../core/validate.js';
import { columnWidth, pad } from '../../ui/output.js';
import { symbols } from '../../ui/style.js';
import type { App } from '../app.js';
import { recoverAccount, signInAndPick } from '../auth.js';

export interface AccountAddOptions {
  alias?: string;
}

export async function accountAdd(
  app: App,
  name: string | undefined,
  options: AccountAddOptions,
): Promise<Account> {
  await app.shopify.ensureSupported();
  // Reject a taken name before sending anyone through a sign-in.
  const chosenName = validateName(
    name ??
      (await app.prompts.text('Name this account', {
        placeholder: 'personal, agency, client-name',
        alternative: 'shopshift account add <name> --alias <alias>',
        check: (value) => assertNameFree(app.store.read(), value),
      })),
    'Account name',
  );
  assertNameFree(app.store.read(), chosenName);

  const alias = options.alias === undefined ? await obtainAlias(app) : validateAlias(options.alias);
  if (options.alias !== undefined) {
    const status = await app.out.working('Checking the Shopify session', () =>
      app.shopify.aliasStatus(alias),
    );
    if (status === 'missing') {
      throw new ShopShiftError('AUTH_MISSING', `Shopify CLI has no session called "${alias}".`, {
        hint: 'Sign in first with "shopify auth login", or run "shopshift account add" without --alias.',
      });
    }
  }
  const account = await app.accounts.add({ name: chosenName, alias });
  app.out.success(`Added ${app.out.note.bold(account.name)} (${account.alias})`);
  return account;
}

async function obtainAlias(app: App): Promise<string> {
  const how = await app.prompts.select(
    'How should ShopShift connect?',
    [
      { value: 'existing', label: 'Use an account already signed in to Shopify CLI' },
      { value: 'new', label: 'Sign in to another account', hint: 'opens your browser' },
    ],
    { alternative: 'shopshift account add <name> --alias <alias>' },
  );
  return how === 'new' ? signInAndPick(app) : app.shopify.pickAccount();
}

function assertNameFree(config: Config, name: string): void {
  const id = slugify(validateName(name, 'Account name'));
  if (Object.hasOwn(config.accounts, id)) {
    throw new ShopShiftError('ACCOUNT_EXISTS', `An account called "${id}" already exists.`);
  }
}

export async function accountList(
  app: App,
  options: { json?: boolean; check?: boolean },
): Promise<void> {
  const config = app.store.read();
  const accounts = listAccounts(config);
  const status = new Map<string, string>();
  if (options.check === true) {
    await app.out.working('Checking Shopify sessions', async () => {
      for (const account of accounts) {
        status.set(account.id, await app.shopify.aliasStatus(account.alias).catch(() => 'unknown'));
      }
    });
  }
  if (options.json === true) {
    app.out.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        alias: account.alias,
        default: account.id === config.defaultAccount,
        workspaces: workspacesUsingAccount(config, account.id),
        ...(status.has(account.id) ? { session: status.get(account.id) } : {}),
      })),
    });
    return;
  }
  if (accounts.length === 0) {
    app.out.say('No accounts yet. Add one with: shopshift account add');
    return;
  }
  const { style } = app.out;
  const nameWidth = columnWidth(accounts.map((account) => account.name)) + 3;
  const aliasWidth = columnWidth(accounts.map((account) => account.alias)) + 3;
  app.out.print();
  for (const account of accounts) {
    const isDefault = account.id === config.defaultAccount;
    const used = workspacesUsingAccount(config, account.id).length;
    const session = status.get(account.id);
    const health =
      session === undefined
        ? ''
        : session === 'available'
          ? `  ${style.success('signed in')}`
          : `  ${style.danger(session === 'missing' ? 'signed out' : 'unknown')}`;
    app.out.print(
      `  ${isDefault ? style.accent(symbols.active) : style.dim(symbols.inactive)} ${style.bold(pad(account.name, nameWidth))}${pad(account.alias, aliasWidth)}${style.dim(`${used} workspace${used === 1 ? '' : 's'}`)}${health}`,
    );
  }
  app.out.print();
}

export async function accountUse(
  app: App,
  reference: string | undefined,
  options: { global: boolean },
): Promise<void> {
  const config = app.store.read();
  const chosen = getAccount(
    config,
    reference ?? (await pickProfile(app, config, 'Switch to which account?')),
  );
  if (options.global) {
    await app.out.working('Switching Shopify CLI', () => app.shopify.switchCurrent(chosen.alias));
  }
  await app.accounts.setDefault(chosen.id);
  app.out.success(`Now using ${app.out.note.bold(chosen.name)} (${chosen.alias})`);
  app.out.info(
    options.global
      ? '  Bare "shopify" commands use this account too. Workspaces keep their own.'
      : '  New workspaces default to this account. Shopify CLI was left as it is.',
  );
}

export async function accountLogin(app: App, reference: string | undefined): Promise<void> {
  await app.shopify.ensureSupported();
  const config = app.store.read();
  const account = getAccount(
    config,
    reference ?? (await pickProfile(app, config, 'Sign in to which account?')),
  );
  const store = Object.values(config.workspaces).find(
    (workspace) => workspace.account === account.id,
  )?.store;
  const status = await app.out.working('Checking the Shopify session', () =>
    app.shopify.aliasStatus(account.alias),
  );

  if (status === 'missing') {
    await recoverAccount(app, account, 'missing', store);
    return;
  }
  if (store === undefined) {
    // Without a store there is nothing to make an authenticated request against.
    app.out.success(`Shopify CLI has a session for ${account.alias}.`);
    app.out.info('  It will be renewed, if it has expired, the first time a workspace uses it.');
    return;
  }
  try {
    await app.out.working('Checking the session with Shopify', async () => {
      await app.shopify.listThemes({ store, alias: account.alias });
    });
    app.out.success(`${account.alias} is signed in. Nothing to do.`);
  } catch (error) {
    if (!(error instanceof ShopShiftError) || error.code !== 'AUTH_EXPIRED') throw error;
    await recoverAccount(app, account, 'expired', store);
  }
}

export async function accountRemove(
  app: App,
  reference: string | undefined,
  options: { yes?: boolean },
): Promise<void> {
  const config = app.store.read();
  const account = getAccount(
    config,
    reference ?? (await pickProfile(app, config, 'Remove which account?')),
  );
  if (options.yes !== true) {
    const confirmed = await app.prompts.confirm(
      `Remove the profile "${account.name}" (${account.alias})?`,
      {
        alternative: `shopshift account remove ${account.id} --yes`,
      },
    );
    if (!confirmed) throw new ShopShiftError('CANCELLED', 'Nothing was removed.');
  }
  const running = app.sessions.list().filter((session) => isProcessAlive(session.pid));
  await app.accounts.remove(account.id);
  app.out.success(`Removed ${account.name}`);
  app.out.info(
    '  Its Shopify session is untouched. "shopify auth logout" would sign out every account.',
  );
  if (running.length > 0)
    app.out.info('  Development servers that are already running are not affected.');
}

async function pickProfile(app: App, config: Config, message: string): Promise<string> {
  const accounts = listAccounts(config);
  if (accounts.length === 0) {
    throw new ShopShiftError('ACCOUNT_NOT_FOUND', 'There are no accounts yet.', {
      hint: 'shopshift account add',
    });
  }
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only.id;
  return app.prompts.select(
    message,
    accounts.map((account) => ({ value: account.id, label: account.name, hint: account.alias })),
    { initial: config.defaultAccount, alternative: 'Name the account as an argument.' },
  );
}

/** Used by the workspace wizard: choose an existing account, or add one on the spot. */
export async function chooseOrAddAccount(app: App, preferred?: string): Promise<Account> {
  const config = app.store.read();
  const accounts = listAccounts(config);
  if (accounts.length === 0) {
    app.out.info('First, connect a Shopify account.');
    return accountAdd(app, undefined, {});
  }
  const choice = await app.prompts.select(
    'Shopify account',
    [
      ...accounts.map((account) => ({
        value: account.id,
        label: account.name,
        hint: account.alias,
      })),
      { value: '+', label: '+ Add an account' },
    ],
    {
      initial: findAccount(config, preferred ?? config.defaultAccount ?? '')?.id,
      alternative: 'Use --account <account>.',
    },
  );
  return choice === '+' ? accountAdd(app, undefined, {}) : getAccount(app.store.read(), choice);
}
