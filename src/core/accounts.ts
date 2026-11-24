import type { Account, Config } from './config/schema.js';
import type { ConfigStore } from './config/store.js';
import { ShopShiftError } from './errors.js';
import { slugify, validateAlias, validateName } from './validate.js';

export function listAccounts(config: Config): Account[] {
  return Object.values(config.accounts).sort((a, b) => a.name.localeCompare(b.name));
}

export function findAccount(config: Config, reference: string): Account | undefined {
  if (Object.hasOwn(config.accounts, reference)) return config.accounts[reference];
  const wanted = reference.trim().toLowerCase();
  return listAccounts(config).find(
    (account) => account.name.toLowerCase() === wanted || account.id === wanted,
  );
}

export function getAccount(config: Config, reference: string): Account {
  const account = findAccount(config, reference);
  if (account !== undefined) return account;
  const known = listAccounts(config).map((item) => item.id);
  throw new ShopShiftError('ACCOUNT_NOT_FOUND', `No account called "${reference}".`, {
    hint:
      known.length === 0
        ? 'Add one with: shopshift account add'
        : `Known accounts: ${known.join(', ')}`,
  });
}

export function workspacesUsingAccount(config: Config, accountId: string): string[] {
  return Object.values(config.workspaces)
    .filter((workspace) => workspace.account === accountId)
    .map((workspace) => workspace.id);
}

export class AccountManager {
  constructor(private readonly store: ConfigStore) {}

  async add(input: { name: string; alias: string }): Promise<Account> {
    const name = validateName(input.name, 'Account name');
    const alias = validateAlias(input.alias);
    const id = slugify(name);
    return this.store.update((config) => {
      if (Object.hasOwn(config.accounts, id)) {
        throw new ShopShiftError('ACCOUNT_EXISTS', `An account called "${id}" already exists.`, {
          hint: 'Choose another name, or remove the existing one first.',
        });
      }
      // Two profiles for one alias would look like two identities while being the same one.
      const duplicate = listAccounts(config).find((account) => account.alias === alias);
      if (duplicate !== undefined) {
        throw new ShopShiftError('ACCOUNT_EXISTS', `"${duplicate.name}" already uses ${alias}.`, {
          hint: `Use it with: shopshift account use ${duplicate.id}`,
        });
      }
      const account: Account = { id, name, alias, createdAt: new Date().toISOString() };
      config.accounts[id] = account;
      config.defaultAccount ??= id;
      return account;
    });
  }

  async relink(reference: string, newAlias: string): Promise<Account> {
    const alias = validateAlias(newAlias);
    return this.store.update((config) => {
      const account = getAccount(config, reference);
      const duplicate = listAccounts(config).find(
        (other) => other.alias === alias && other.id !== account.id,
      );
      if (duplicate !== undefined) {
        throw new ShopShiftError('ACCOUNT_EXISTS', `"${duplicate.name}" already uses ${alias}.`);
      }
      account.alias = alias;
      return account;
    });
  }

  async setDefault(reference: string): Promise<Account> {
    return this.store.update((config) => {
      const account = getAccount(config, reference);
      config.defaultAccount = account.id;
      return account;
    });
  }

  /** Removes the profile only. The Shopify session itself is left alone; see `account remove` help. */
  async remove(reference: string): Promise<Account> {
    return this.store.update((config) => {
      const account = getAccount(config, reference);
      const inUse = workspacesUsingAccount(config, account.id);
      if (inUse.length > 0) {
        throw new ShopShiftError(
          'ACCOUNT_IN_USE',
          `"${account.name}" is used by ${inUse.join(', ')}.`,
          {
            hint: `Move them first: shopshift edit ${inUse[0]} --account <other-account>`,
          },
        );
      }
      delete config.accounts[account.id];
      if (config.defaultAccount === account.id) {
        delete config.defaultAccount;
        const next = listAccounts(config)[0];
        if (next !== undefined) config.defaultAccount = next.id;
      }
      return account;
    });
  }
}
