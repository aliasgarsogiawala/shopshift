import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './config/schema.js';
import { ShopShiftError } from './errors.js';
import type { Env } from './paths.js';
import { storeHandle } from './validate.js';

export function adminUrl(workspace: Pick<Workspace, 'store'>): string {
  return `https://admin.shopify.com/store/${storeHandle(workspace.store)}`;
}

export function themesAdminUrl(workspace: Pick<Workspace, 'store'>): string {
  return `${adminUrl(workspace)}/themes`;
}

export function storefrontUrl(workspace: Pick<Workspace, 'store'>): string {
  return `https://${workspace.store}`;
}

/** Opens a URL with the operating system's handler. Never goes through a shell. */
export async function openUrl(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const { protocol } = new URL(url);
  if (protocol !== 'https:') throw new ShopShiftError('OPEN_FAILED', `Refusing to open ${url}.`);
  const [file, args] =
    platform === 'darwin'
      ? ['/usr/bin/open', [url]]
      : platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await launchDetached(
    file as string,
    args as string[],
    () =>
      new ShopShiftError('OPEN_FAILED', 'Could not open your browser.', {
        hint: `Open it yourself: ${url}`,
      }),
  );
}

export interface EditorCommand {
  file: string;
  args: string[];
  /** Terminal editors take over the terminal; graphical ones are left running. */
  terminal: boolean;
}

const KNOWN_EDITORS = ['cursor', 'code', 'zed', 'windsurf', 'subl', 'webstorm', 'phpstorm', 'nova'];
const TERMINAL_EDITORS = new Set([
  'vi',
  'vim',
  'nvim',
  'nano',
  'emacs',
  'hx',
  'helix',
  'micro',
  'kak',
]);

/** Preference order: ShopShift's setting, then $VISUAL, then $EDITOR, then a well-known editor. */
export function resolveEditor(
  preference: string | undefined,
  env: Env = process.env,
): EditorCommand {
  for (const configured of [preference, env.SHOPSHIFT_EDITOR, env.VISUAL, env.EDITOR]) {
    if (configured === undefined || configured.trim() === '') continue;
    const [program, ...args] = splitWords(configured);
    if (program === undefined) continue;
    const file = findExecutable(program, env);
    if (file === undefined) {
      throw new ShopShiftError('EDITOR_NOT_FOUND', `Your editor "${program}" was not found.`, {
        hint: 'Choose another with: shopshift config set editor code',
      });
    }
    return { file, args, terminal: TERMINAL_EDITORS.has(path.basename(program)) };
  }
  for (const candidate of KNOWN_EDITORS) {
    const file = findExecutable(candidate, env);
    if (file !== undefined) return { file, args: [], terminal: false };
  }
  throw new ShopShiftError('EDITOR_NOT_FOUND', 'No code editor was found.', {
    hint: 'Choose one with: shopshift config set editor code',
  });
}

export async function openEditor(editor: EditorCommand, directory: string): Promise<void> {
  const args = [...editor.args, directory];
  if (!editor.terminal) {
    await launchDetached(
      editor.file,
      args,
      (error) =>
        new ShopShiftError('EDITOR_NOT_FOUND', `Could not start ${editor.file}: ${error.message}`),
    );
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor.file, args, { stdio: 'inherit', cwd: directory, shell: false });
    child.once('error', reject);
    child.once('close', () => resolve());
  });
}

/** Splits a command setting such as `code --reuse-window`, honouring quotes but nothing else. */
export function splitWords(input: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== undefined) {
    throw new ShopShiftError('VALIDATION', `The editor command has an unclosed quote: ${input}`);
  }
  if (started) words.push(current);
  return words;
}

export function findExecutable(program: string, env: Env = process.env): string | undefined {
  if (path.isAbsolute(program)) return isExecutable(program) ? program : undefined;
  if (program.includes('/') || program.includes('\\')) return undefined;
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const directory of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (directory === '' || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, program + extension);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function isExecutable(target: string): boolean {
  try {
    accessSync(target, constants.X_OK);
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

function launchDetached(
  file: string,
  args: string[],
  describe: (error: Error) => ShopShiftError,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: true, shell: false });
    child.once('error', (error) => reject(describe(error)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
