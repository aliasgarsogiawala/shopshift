import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { ShopShiftError } from '../core/errors.js';
import { type App, createApp } from './app.js';
import * as account from './commands/account.js';
import { home, init, TAGLINE } from './commands/home.js';
import * as misc from './commands/misc.js';
import * as theme from './commands/theme.js';
import * as workspace from './commands/workspace.js';

export function packageVersion(): string {
  const file = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

export function createProgram(app: App): Command {
  const program = new Command('shopshift');
  program
    .description(TAGLINE)
    .version(packageVersion(), '-V, --version', 'Show the version')
    .helpOption('-h, --help', 'Show help')
    .helpCommand(false)
    // Keeps options that follow a subcommand, such as `check --version`, with that subcommand.
    .enablePositionalOptions()
    .showSuggestionAfterError(true)
    .configureOutput({ writeErr: (text) => app.out.say(text.trimEnd()) })
    .exitOverride()
    .action(async () => home(app, () => program.outputHelp()));

  program.commandsGroup('Get started:');
  program
    .command('init')
    .description('Set up ShopShift for this machine and project')
    .action(async () => init(app));
  program
    .command('doctor')
    .description('Check your setup and explain how to fix it')
    .option('--json', 'Print the results as JSON')
    .action(async (options) => misc.doctor(app, options, process.version));

  program.commandsGroup('Workspaces:');
  program
    .command('add')
    .description('Add a workspace')
    .argument('[name]', 'Workspace name')
    .option('-s, --store <store>', 'Store, for example your-store.myshopify.com')
    .option('-a, --account <account>', 'Account profile')
    .option('-d, --dir <path>', 'Project directory (default: the current one)')
    .option('-t, --theme <id>', 'Default theme ID for push and pull')
    .option('-e, --environment <name>', 'Environment from shopify.theme.toml')
    .option('-p, --port <port>', 'Preferred development port')
    .action(async (name, options) => {
      await workspace.add(app, name, options);
    });
  program
    .command('list')
    .alias('ls')
    .description('List workspaces')
    .option('--json', 'Print as JSON')
    .action((options) => workspace.list(app, options));
  program
    .command('use')
    .description('Switch the active workspace')
    .argument('[workspace]')
    .action(async (reference) => {
      await workspace.use(app, reference);
    });
  program
    .command('edit')
    .description('Change a workspace')
    .argument('[workspace]')
    .option('--name <name>', 'Rename it')
    .option('-s, --store <store>', 'Store')
    .option('-a, --account <account>', 'Account profile')
    .option('-d, --dir <path>', 'Project directory')
    .option('-t, --theme <id>', 'Default theme ID')
    .option('--no-theme', 'Clear the default theme')
    .option('-e, --environment <name>', 'Environment from shopify.theme.toml')
    .option('--no-environment', 'Clear the environment')
    .option('-p, --port <port>', 'Preferred development port')
    .option('--no-port', 'Clear the preferred port')
    .action(async (reference, _options, command: Command) =>
      workspace.edit(app, reference, explicitOptions(command)),
    );
  program
    .command('remove')
    .alias('rm')
    .description('Forget a workspace (files and store are untouched)')
    .argument('[workspace]')
    .option('-y, --yes', 'Skip the confirmation')
    .action(async (reference, options) => workspace.remove(app, reference, options));
  program
    .command('status')
    .description('Show the current workspace and running servers')
    .option('-w, --workspace <workspace>', 'Show another workspace')
    .option('--check', 'Also check the Shopify session')
    .option('--json', 'Print as JSON')
    .action(async (options) => workspace.status(app, options));
  program
    .command('current')
    .description('Print the workspace for this directory')
    .option('--field <name>', 'Print one value, for example store or directory')
    .option('--json', 'Print as JSON')
    .action((options) => workspace.current(app, options));

  program.commandsGroup('Themes (other options are passed to Shopify CLI):');
  themeCommand(program, 'dev', 'Start a development server')
    .option('--confirm-live <theme-id>', 'Confirm developing on this live theme')
    .option('--allow-shared-theme', 'Allow a second server on the same development theme')
    .action(async (args, options) => theme.dev(app, args, options));
  themeCommand(program, 'pull', 'Download a theme').action(async (args, options) =>
    theme.pull(app, args, options),
  );
  themeCommand(program, 'push', 'Upload a theme, after showing exactly where it will go')
    .option('-y, --yes', 'Skip the confirmation (never applies to live themes)')
    .option('--confirm-live <theme-id>', 'Confirm pushing to this live theme')
    .action(async (args, options) => theme.push(app, args, options));
  themeCommand(program, 'themes', 'List the themes on the store').action(async (args, options) =>
    theme.themes(app, args, options),
  );
  themeCommand(program, 'check', 'Run Theme Check').action(async (args, options) =>
    theme.check(app, args, options),
  );
  themeCommand(program, 'info', 'Show theme information').action(async (args, options) =>
    theme.info(app, args, options),
  );

  program.commandsGroup('Open:');
  const open = program
    .command('open')
    .description('Open the admin, the storefront, the themes page or your editor');
  for (const [target, description] of [
    ['admin', 'Open the Shopify admin'],
    ['store', 'Open the storefront'],
    ['themes', 'Open the themes page in the admin'],
    ['editor', 'Open the project in your code editor'],
  ] as const) {
    open
      .command(target)
      .description(description)
      .option('-w, --workspace <workspace>', 'Use another workspace')
      .option('--print', 'Print the location instead of opening it')
      .action(async (options) => misc.open(app, target, options));
  }

  program.commandsGroup('Accounts and settings:');
  const accounts = program.command('account').description('Manage Shopify accounts');
  accounts
    .command('add')
    .description('Add an account profile')
    .argument('[name]', 'Display name')
    .option(
      '--alias <alias>',
      'Alias of an account already signed in to Shopify CLI (usually its email)',
    )
    .action(async (name, options) => {
      await account.accountAdd(app, name, options);
    });
  accounts
    .command('list')
    .alias('ls')
    .description('List account profiles')
    .option('--check', 'Also check each Shopify session')
    .option('--json', 'Print as JSON')
    .action(async (options) => account.accountList(app, options));
  accounts
    .command('use')
    .description('Make an account the default, here and in Shopify CLI')
    .argument('[account]')
    .option('--no-global', 'Leave Shopify CLI as it is')
    .action(async (reference, options) => account.accountUse(app, reference, options));
  accounts
    .command('login')
    .description('Renew an expired or missing Shopify session')
    .argument('[account]')
    .action(async (reference) => account.accountLogin(app, reference));
  accounts
    .command('remove')
    .alias('rm')
    .description('Remove an account profile (its Shopify session is untouched)')
    .argument('[account]')
    .option('-y, --yes', 'Skip the confirmation')
    .action(async (reference, options) => account.accountRemove(app, reference, options));

  const shell = program.command('shell').description('Shell integration');
  shell
    .command('init')
    .description('Print the integration script for zsh or bash')
    .argument('<shell>', 'zsh or bash')
    .option('--no-cd', 'Do not let "shopshift use" change directory')
    .action((name, options) => misc.shellInit(app, name, options));

  const config = program.command('config').description('Settings');
  config
    .command('get')
    .description('Print a setting')
    .argument('<key>')
    .action((key) => misc.configGet(app, key));
  config
    .command('set')
    .description('Change a setting, for example: config set editor "code --reuse-window"')
    .argument('<key>')
    .argument('<value>')
    .action(async (key, value) => misc.configSet(app, key, value));
  config
    .command('unset')
    .description('Clear a setting')
    .argument('<key>')
    .action(async (key) => misc.configUnset(app, key));
  config
    .command('path')
    .description('Print the location of the configuration file')
    .action(() => misc.configPath(app));

  inheritSettings(program);
  return program;
}

function themeCommand(program: Command, name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .argument('[args...]', 'Options for Shopify CLI')
    .usage('[options] [Shopify CLI options]')
    .allowUnknownOption(true)
    .option('-w, --workspace <workspace>', 'Use another workspace')
    .option('--use-theme-token', 'Authenticate with a theme token instead of the workspace account')
    .option('--dry-run', 'Show the Shopify command without running it');
}

/** Commander gives a `--no-x` option a default of true, which must not look like a value. */
function explicitOptions(command: Command): Record<string, never> {
  return Object.fromEntries(
    Object.entries(command.opts()).filter(([key]) => command.getOptionValueSource(key) === 'cli'),
  ) as Record<string, never>;
}

function inheritSettings(parent: Command): void {
  for (const command of parent.commands) {
    command.copyInheritedSettings(parent).helpOption('-h, --help', 'Show help').helpCommand(false);
    inheritSettings(command);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  let app: App | undefined;
  try {
    app = createApp();
    const program = createProgram(app);
    assertKnownCommand(program, argv[0]);
    await program.parseAsync([...argv], { from: 'user' });
  } catch (error) {
    process.exitCode = reportError(app ?? createApp(), error, argv.includes('--json'));
  }
}

/** The root command has its own action, so commander would call a typo "too many arguments". */
function assertKnownCommand(program: Command, name: string | undefined): void {
  if (name === undefined || name.startsWith('-')) return;
  const known = program.commands.flatMap((command) => [command.name(), ...command.aliases()]);
  if (known.includes(name)) return;
  const close = known.filter((candidate) => editDistance(candidate, name) <= 2);
  throw new ShopShiftError('USAGE', `Unknown command "${name}".`, {
    hint:
      close.length > 0
        ? `Did you mean: ${close.join(', ')}`
        : 'See all commands with: shopshift --help',
  });
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      const substitution = (previous[column - 1] ?? 0) + (a[row - 1] === b[column - 1] ? 0 : 1);
      current.push(
        Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function reportError(app: App, error: unknown, json: boolean): number {
  if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
  if (error instanceof ShopShiftError) {
    if (json) app.out.json({ error: error.toJSON() });
    if (error.code === 'CANCELLED') app.out.say(app.out.note.dim(error.message));
    else app.out.error(error.message, { details: error.details, hint: error.hint });
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (json) app.out.json({ error: { code: 'INTERNAL', message } });
  app.out.error(`Something went wrong: ${message}`, {
    details: app.env.SHOPSHIFT_DEBUG && error instanceof Error && error.stack ? [error.stack] : [],
    hint: 'This is a bug in ShopShift. Run again with SHOPSHIFT_DEBUG=1 for details.',
  });
  return 70;
}
