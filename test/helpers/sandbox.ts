import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RemoteTheme } from '../../src/core/shopify/client.js';

const BIN = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
export const MOCK_SHOPIFY = fileURLToPath(new URL('./mock-shopify.mjs', import.meta.url));

export interface MockCall {
  argv: string[];
  cwd: string;
  pid: number;
  at: number;
  env: Record<string, string>;
  tty: [boolean, boolean, boolean];
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** POSIX signals and process groups behave differently on Windows. */
export const onWindows = process.platform === 'win32';

export const THEMES: RemoteTheme[] = [
  { id: '100', name: 'Dawn', role: 'live' },
  { id: '200', name: 'Staging', role: 'unpublished' },
  { id: '300', name: 'Development (abc)', role: 'development' },
  { id: '400', name: 'Copy', role: 'unpublished' },
  { id: '401', name: 'copy', role: 'unpublished' },
];

/** A private home, configuration, project tree and mock Shopify CLI for one test. */
export class Sandbox {
  readonly root: string;
  readonly home: string;
  readonly configDir: string;
  readonly mockState: string;
  readonly projects: string;

  constructor() {
    this.root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'shopshift-')));
    this.home = this.dir('home');
    this.configDir = path.join(this.root, 'config');
    this.mockState = this.dir('mock');
    this.projects = this.dir('projects');
    this.mock('aliases', ['me@example.test', 'agency@example.test']);
    this.mock('themes', THEMES);
  }

  dir(...segments: string[]): string {
    const full = path.join(this.root, ...segments);
    mkdirSync(full, { recursive: true });
    return full;
  }

  /** Creates a directory that looks like a theme. */
  theme(name: string): string {
    const directory = path.join(this.projects, name);
    for (const child of ['config', 'layout', 'templates', 'sections']) {
      mkdirSync(path.join(directory, child), { recursive: true });
    }
    return directory;
  }

  file(relative: string, contents: string): string {
    const full = path.join(this.root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    return full;
  }

  mock(name: string, value: unknown): void {
    writeFileSync(path.join(this.mockState, `${name}.json`), JSON.stringify(value));
  }

  get env(): Record<string, string> {
    return {
      PATH: process.env.PATH ?? '',
      HOME: this.home,
      USERPROFILE: this.home,
      TMPDIR: tmpdir(),
      SHOPSHIFT_CONFIG_DIR: this.configDir,
      SHOPSHIFT_SHOPIFY_BIN: MOCK_SHOPIFY,
      MOCK_STATE: this.mockState,
      NO_COLOR: '1',
      // Windows needs these to start processes at all.
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.ComSpec === undefined ? {} : { ComSpec: process.env.ComSpec }),
    };
  }

  start(args: string[], options: RunOptions = {}): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...this.env };
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawn(process.execPath, [BIN, ...args], {
      cwd: options.cwd ?? this.projects,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  run(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return collect(this.start(args, options));
  }

  calls(): MockCall[] {
    try {
      return readFileSync(path.join(this.mockState, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as MockCall);
    } catch {
      return [];
    }
  }

  /** Calls to one theme command, ignoring the checks ShopShift makes along the way. */
  themeCalls(command: string): MockCall[] {
    return this.calls().filter((call) => call.argv[0] === 'theme' && call.argv[1] === command);
  }

  config(): {
    workspaces: Record<string, Record<string, unknown>>;
    accounts: Record<string, unknown>;
    [key: string]: unknown;
  } {
    return JSON.parse(readFileSync(path.join(this.configDir, 'config.json'), 'utf8'));
  }

  /** Two accounts and one workspace, which most tests start from. */
  async seed(
    options: { theme?: string; port?: number; environment?: string } = {},
  ): Promise<string> {
    const directory = this.theme('tangelo');
    await this.ok(['account', 'add', 'Personal', '--alias', 'me@example.test']);
    await this.ok(['account', 'add', 'Agency', '--alias', 'agency@example.test']);
    await this.ok([
      'add',
      'Tangelo',
      '--store',
      'tangelo-demo',
      '--account',
      'personal',
      '--dir',
      directory,
      ...(options.theme === undefined ? [] : ['--theme', options.theme]),
      ...(options.port === undefined ? [] : ['--port', String(options.port)]),
      ...(options.environment === undefined ? [] : ['--environment', options.environment]),
    ]);
    this.resetCalls();
    return directory;
  }

  resetCalls(): void {
    rmSync(path.join(this.mockState, 'calls.jsonl'), { force: true });
  }

  async ok(args: string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await this.run(args, options);
    if (result.code !== 0) {
      throw new Error(
        `shopshift ${args.join(' ')} exited ${result.code}\n${result.stdout}${result.stderr}`,
      );
    }
    return result;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5 });
  }
}

export function collect(child: ChildProcess): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** An ephemeral port that was free a moment ago. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export async function occupy(port: number): Promise<() => Promise<void>> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return () => new Promise((resolve) => server.close(() => resolve()));
}
