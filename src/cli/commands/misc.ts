import type { CheckResult } from '../../core/doctor.js';
import { runDoctor } from '../../core/doctor.js';
import { ShopShiftError } from '../../core/errors.js';
import {
  adminUrl,
  openEditor,
  openUrl,
  resolveEditor,
  splitWords,
  storefrontUrl,
  themesAdminUrl,
} from '../../core/opener.js';
import { displayPath, isDirectory } from '../../core/paths.js';
import type { Shell } from '../../core/shell/hook.js';
import { installLine, rcFile, shellScript } from '../../core/shell/scripts.js';
import { symbols } from '../../ui/style.js';
import type { App } from '../app.js';
import { chooseWorkspace } from '../select.js';

export type OpenTarget = 'admin' | 'store' | 'themes' | 'editor';

export async function open(
  app: App,
  target: OpenTarget,
  options: { workspace?: string; print?: boolean },
): Promise<void> {
  const config = app.store.read();
  const { workspace } = await chooseWorkspace(app, config, `open ${target}`, options.workspace);

  if (target === 'editor') {
    if (!isDirectory(workspace.directory)) {
      throw new ShopShiftError(
        'DIRECTORY_INVALID',
        `${displayPath(workspace.directory)} no longer exists.`,
        {
          hint: `shopshift edit ${workspace.id} --dir <path>`,
        },
      );
    }
    if (options.print === true) {
      app.out.print(workspace.directory);
      return;
    }
    const editor = resolveEditor(config.preferences.editor, app.env);
    await openEditor(editor, workspace.directory);
    app.out.success(`Opened ${displayPath(workspace.directory)}`);
    return;
  }

  const url = { admin: adminUrl, store: storefrontUrl, themes: themesAdminUrl }[target](workspace);
  if (options.print === true) {
    app.out.print(url);
    return;
  }
  await openUrl(url);
  app.out.success(`Opened ${url}`);
}

export async function doctor(
  app: App,
  options: { json?: boolean },
  nodeVersion: string,
): Promise<void> {
  const results = await app.out.working('Checking your setup', () =>
    runDoctor({
      store: app.store,
      shopify: app.shopify,
      sessions: app.sessions,
      env: app.env,
      nodeVersion,
    }),
  );
  const failed = results.filter((result) => result.status === 'fail').length;
  const warned = results.filter((result) => result.status === 'warn').length;
  if (failed > 0) process.exitCode = 1;
  if (options.json === true) {
    app.out.json({ ok: failed === 0, checks: results });
    return;
  }

  const { style } = app.out;
  const icon = {
    ok: style.success(symbols.success),
    warn: style.warning(symbols.warning),
    fail: style.danger(symbols.error),
  };
  let group: CheckResult['group'] | undefined;
  for (const result of results) {
    if (result.group !== group) {
      group = result.group;
      app.out.print();
      app.out.print(`  ${style.bold(group)}`);
    }
    app.out.print(`  ${icon[result.status]} ${result.title}`);
    for (const line of result.detail?.split('\n') ?? []) app.out.print(`    ${style.dim(line)}`);
    for (const line of result.fix?.split('\n') ?? [])
      app.out.print(`    ${style.accent(symbols.arrow)} ${line}`);
  }
  app.out.print();
  const summary = [
    failed > 0 ? style.danger(`${failed} problem${failed === 1 ? '' : 's'}`) : undefined,
    warned > 0 ? style.warning(`${warned} warning${warned === 1 ? '' : 's'}`) : undefined,
  ].filter((part) => part !== undefined);
  app.out.print(
    `  ${summary.length === 0 ? style.success('Everything looks good.') : summary.join(', ')}`,
  );
  app.out.print();
}

export function shellInit(app: App, shell: string, options: { cd: boolean }): void {
  const supported = assertShell(shell);
  process.stdout.write(shellScript(supported, options));
  // Printed to a terminal, the script is not doing anything yet, so explain how to enable it.
  if (process.stdout.isTTY === true) {
    app.out.say();
    app.out.say(`To enable it, add this line to ${rcFile(supported)} yourself:`);
    app.out.say(`  ${installLine(supported)}`);
  }
}

export function assertShell(shell: string): Shell {
  if (shell === 'zsh' || shell === 'bash') return shell;
  throw new ShopShiftError('USAGE', `"${shell}" is not supported.`, { hint: 'Use zsh or bash.' });
}

export function configGet(app: App, key: string): void {
  assertEditorKey(key);
  const value = app.store.read().preferences.editor;
  if (value === undefined)
    throw new ShopShiftError('USAGE', 'No editor is set.', {
      hint: 'shopshift config set editor code',
    });
  app.out.print(value);
}

export async function configSet(app: App, key: string, value: string): Promise<void> {
  assertEditorKey(key);
  if (splitWords(value).length === 0)
    throw new ShopShiftError('VALIDATION', 'The editor cannot be empty.');
  await app.store.update((config) => {
    config.preferences.editor = value.trim();
  });
  app.out.success(`Editor set to ${value.trim()}`);
}

export async function configUnset(app: App, key: string): Promise<void> {
  assertEditorKey(key);
  await app.store.update((config) => {
    delete config.preferences.editor;
  });
  app.out.success('Editor cleared');
}

export function configPath(app: App): void {
  app.out.print(app.paths.configFile);
}

function assertEditorKey(key: string): void {
  if (key !== 'editor')
    throw new ShopShiftError('USAGE', `Unknown setting "${key}".`, { hint: 'Available: editor' });
}
