import type { Account } from '../core/config/schema.js';
import { ShopShiftError } from '../core/errors.js';
import type { App } from './app.js';

/** Signs in through Shopify's own flow and returns the exact alias Shopify CLI stored. */
export async function signInAndPick(app: App): Promise<string> {
  app.out.info('Shopify CLI will open your browser to sign in.');
  const status = await app.shopify.login();
  if (status.code !== 0)
    throw new ShopShiftError('AUTH_MISSING', 'The Shopify sign-in did not finish.');
  // Shopify names the session itself, so read the name back instead of asking for it.
  app.out.info('Confirm which account you signed in to:');
  return app.shopify.pickAccount();
}

/** Gets an account's Shopify session working again. */
export async function recoverAccount(
  app: App,
  account: Account,
  reason: 'missing' | 'expired',
  store: string | undefined,
): Promise<Account> {
  if (!app.prompts.interactive) {
    throw new ShopShiftError(
      reason === 'missing' ? 'AUTH_MISSING' : 'AUTH_EXPIRED',
      `Shopify needs you to sign in as ${account.alias}.`,
      { hint: `Run this in a terminal: shopshift account login ${account.id}` },
    );
  }
  // Shopify CLI keeps the old alias on a renewed session even if a different person signs in.
  app.out.warn(
    `Make sure your browser is signed in as ${app.out.note.bold(account.alias)} before approving.`,
  );

  if (reason === 'expired' && store !== undefined) {
    const status = await app.shopify.run(
      ['theme', 'list', '--store', store, '--auth-alias', account.alias],
      { store, alias: account.alias, cwd: app.paths.stateDir },
      { stdout: 'pipe' },
    );
    if (status.code !== 0)
      throw new ShopShiftError('AUTH_EXPIRED', 'The Shopify sign-in did not finish.');
    app.out.success(`Signed in as ${account.alias}`);
    return account;
  }

  const status = await app.shopify.login();
  if (status.code !== 0)
    throw new ShopShiftError('AUTH_MISSING', 'The Shopify sign-in did not finish.');
  if ((await app.shopify.aliasStatus(account.alias)) === 'available') {
    app.out.success(`Signed in as ${account.alias}`);
    return account;
  }

  app.out.warn(
    `Shopify CLI still has no session called ${account.alias}. Choose the account you signed in to:`,
  );
  const alias = await app.shopify.pickAccount();
  if (alias === account.alias) return account;
  const relink = await app.prompts.confirm(`Use ${alias} for "${account.name}" from now on?`, {
    alternative: `shopshift account login ${account.id}`,
  });
  if (!relink)
    throw new ShopShiftError('AUTH_MISSING', `"${account.name}" is still not signed in.`);
  return app.accounts.relink(account.id, alias);
}

/** Runs a task, offering to sign in and retry once if Shopify rejects the session. */
export async function withAuthRecovery<T>(
  app: App,
  account: Account,
  store: string,
  task: (account: Account) => Promise<T>,
): Promise<T> {
  try {
    return await task(account);
  } catch (error) {
    if (!(error instanceof ShopShiftError)) throw error;
    if (error.code !== 'AUTH_MISSING' && error.code !== 'AUTH_EXPIRED') throw error;
    if (!app.prompts.interactive) {
      throw new ShopShiftError(error.code, error.message, {
        hint: `Run this in a terminal: shopshift account login ${account.id}`,
      });
    }
    app.out.warn(error.message);
    const signIn = await app.prompts.confirm('Sign in now?', {
      initial: true,
      alternative: `shopshift account login ${account.id}`,
    });
    if (!signIn) throw error;
    const recovered = await recoverAccount(
      app,
      account,
      error.code === 'AUTH_MISSING' ? 'missing' : 'expired',
      store,
    );
    return task(recovered);
  }
}
