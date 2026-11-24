import { listAccounts } from '../../core/accounts.js';
import { detectWorkspaces } from '../../core/detection.js';
import { displayPath } from '../../core/paths.js';
import { findThemeConfig } from '../../core/theme-config.js';
import { listWorkspaces } from '../../core/workspaces.js';
import type { App } from '../app.js';
import { workspaceChoice } from '../select.js';
import { accountAdd } from './account.js';
import { add, announce, current } from './workspace.js';

export const TAGLINE = 'Multiple stores. One workspace.';

function banner(app: App): void {
  const { note } = app.out;
  app.out.say();
  app.out.say(`  ${note.bold('ShopShift')}`);
  app.out.say(`  ${note.dim(TAGLINE)}`);
  app.out.say();
}

/** `shopshift` on its own. */
export async function home(app: App, showHelp: () => void): Promise<void> {
  const config = app.store.read();
  const workspaces = listWorkspaces(config);
  if (!app.prompts.interactive) {
    if (workspaces.length === 0) showHelp();
    else current(app, {});
    return;
  }
  banner(app);
  if (workspaces.length === 0) {
    app.out.say('  No workspaces yet.');
    app.out.say();
    const start = await app.prompts.confirm('Set up your first workspace?', {
      initial: true,
      alternative: 'shopshift init',
    });
    if (start) await init(app, { quiet: true });
    return;
  }
  const here = detectWorkspaces(config, app.cwd)[0];
  const answer = await app.prompts.select(
    'Select a workspace',
    [
      ...workspaces.map((workspace) => workspaceChoice(config, workspace)),
      { value: '+', label: '+ Add workspace' },
    ],
    { initial: here?.id ?? config.activeWorkspace, alternative: 'shopshift use <workspace>' },
  );
  if (answer === '+') {
    await add(app, undefined, {});
    return;
  }
  announce(app, await app.workspaces.use(answer));
}

/** First run: check Shopify CLI, connect an account, and create a workspace for this project. */
export async function init(app: App, options: { quiet?: boolean } = {}): Promise<void> {
  if (options.quiet !== true) banner(app);
  await app.out.working('Checking Shopify CLI', () => app.shopify.ensureSupported());
  const version = await app.shopify.version();
  app.out.success(`Shopify CLI ${version ?? 'found'}`);

  const config = app.store.read();
  const accounts = listAccounts(config);
  if (accounts.length === 0) {
    if (!app.prompts.interactive) {
      app.out.say('Next: shopshift account add <name> --alias <alias>');
      return;
    }
    await accountAdd(app, undefined, {});
  } else {
    app.out.success(`${accounts.length} account${accounts.length === 1 ? '' : 's'} connected`);
  }

  const existing = detectWorkspaces(app.store.read(), app.cwd);
  if (existing.length > 0) {
    app.out.success(
      `This directory belongs to ${existing.map((workspace) => workspace.name).join(', ')}`,
    );
    return;
  }
  if (!app.prompts.interactive) {
    app.out.say('Next: shopshift add <name> --store <store>');
    return;
  }
  const looksLikeProject = findThemeConfig(app.cwd) !== undefined;
  const create = await app.prompts.confirm(`Create a workspace for ${displayPath(app.cwd)}?`, {
    initial: looksLikeProject || listWorkspaces(app.store.read()).length === 0,
    alternative: 'shopshift add <name> --store <store>',
  });
  if (create) await add(app, undefined, {});
}
