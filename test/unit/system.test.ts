import { spawn } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../src/core/fs/lock.js';
import { LaunchGate } from '../../src/core/launch-gate.js';
import { splitWords } from '../../src/core/opener.js';
import { resolvePaths } from '../../src/core/paths.js';
import { findFreePort, isPortFree } from '../../src/core/ports.js';
import { capture, exitCodeOf, runInteractive } from '../../src/core/process.js';
import { SessionRegistry } from '../../src/core/sessions.js';
import { classifyVersion, compareVersions } from '../../src/core/shopify/version.js';
import { resolveThemeEnvironment } from '../../src/core/theme-config.js';
import { coreSandbox } from '../helpers/core.js';
import { occupy, onWindows } from '../helpers/sandbox.js';

let core: ReturnType<typeof coreSandbox>;
beforeEach(() => {
  core = coreSandbox();
});
afterEach(() => core.dispose());

describe('paths', () => {
  it('uses the conventional directory on each platform', () => {
    expect(resolvePaths({}, 'darwin', '/Users/me').configDir).toBe(
      '/Users/me/Library/Application Support/shopshift',
    );
    expect(resolvePaths({}, 'linux', '/home/me').configDir).toBe('/home/me/.config/shopshift');
    expect(resolvePaths({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/me').configDir).toBe(
      '/xdg/shopshift',
    );
    expect(resolvePaths({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/me').configDir).toBe(
      '/home/me/.config/shopshift',
    );
    expect(resolvePaths({ SHOPSHIFT_CONFIG_DIR: '/custom' }, 'linux', '/home/me').sessionsDir).toBe(
      '/custom/state/sessions',
    );
  });
});

describe('locks', () => {
  const file = () => path.join(core.dir('locks'), 'test.lock');

  it('is exclusive until released', async () => {
    const target = file();
    const first = await acquireLock(target, 'a', { timeoutMs: 100, staleMs: 60_000 });
    expect(first).toBeDefined();
    expect(await acquireLock(target, 'b', { timeoutMs: 150, staleMs: 60_000 })).toBeUndefined();
    first?.release();
    expect(await acquireLock(target, 'b', { timeoutMs: 150, staleMs: 60_000 })).toBeDefined();
  });

  it('takes over a lock whose process has died', async () => {
    const target = file();
    writeFileSync(target, JSON.stringify({ pid: 2_147_483_000, label: 'gone', token: 'x' }));
    expect(await acquireLock(target, 'b', { timeoutMs: 500, staleMs: 60_000 })).toBeDefined();
  });

  it('takes over a lock that is too old', async () => {
    const target = file();
    writeFileSync(target, JSON.stringify({ pid: process.pid, label: 'old', token: 'x' }));
    const old = new Date(Date.now() - 120_000);
    utimesSync(target, old, old);
    expect(await acquireLock(target, 'b', { timeoutMs: 500, staleMs: 60_000 })).toBeDefined();
  });

  it('lets one Shopify command start at a time', async () => {
    const gate = new LaunchGate(core.paths, 300);
    const first = await gate.enter('one');
    let waitedFor: string | undefined;
    const second = gate.enter('two', (holder) => {
      waitedFor = holder?.label;
    });
    setTimeout(() => first.release(), 100);
    expect((await second).exclusive).toBe(true);
    expect(waitedFor).toBe('one');
    const timedOut = await new LaunchGate(core.paths, 100).enter('three');
    expect(timedOut.exclusive).toBe(false);
  });
});

describe('dev sessions', () => {
  it('forgets sessions whose process is gone', async () => {
    const registry = new SessionRegistry(core.paths);
    const base = {
      workspace: 'w',
      store: 's.myshopify.com',
      port: 9292,
      directory: core.root,
      startedAt: new Date().toISOString(),
    };
    const unregister = await registry.register({ ...base, pid: process.pid });
    mkdirSync(core.paths.sessionsDir, { recursive: true });
    writeFileSync(
      path.join(core.paths.sessionsDir, '2147483000.json'),
      JSON.stringify({ ...base, pid: 2_147_483_000 }),
    );
    expect(registry.list().map((session) => session.pid)).toEqual([process.pid]);
    unregister();
    expect(registry.list()).toEqual([]);
  });
});

describe('ports', () => {
  it('skips busy and reserved ports', async () => {
    const start = (await findFreePort(41_000, new Set())) ?? 41_000;
    const release = await occupy(start);
    try {
      expect(await isPortFree(start)).toBe(false);
      expect(await findFreePort(start, new Set([start + 1]))).toBe(start + 2);
    } finally {
      await release();
    }
  });
});

describe('processes', () => {
  const node = (code: string, cwd = core.root) => ({
    file: process.execPath,
    args: ['-e', code],
    cwd,
    env: { PATH: process.env.PATH ?? '' },
  });

  it('passes arguments without a shell', async () => {
    const result = await capture(
      node('console.log(JSON.stringify(process.argv.slice(1)))', core.root),
      { timeoutMs: 5_000 },
    );
    expect(result.code).toBe(0);
    const tricky = {
      ...node('console.log(process.argv[1])'),
      args: ['-e', 'console.log(process.argv[1])', '$(echo pwned); `id` | & ;'],
    };
    expect((await capture(tricky, { timeoutMs: 5_000 })).stdout.trim()).toBe(
      '$(echo pwned); `id` | & ;',
    );
  });

  it.skipIf(onWindows)('reports exit codes and signals', async () => {
    expect(exitCodeOf(await runInteractive(node('process.exit(3)'), { stdout: 'pipe' }))).toBe(3);
    const killed = await runInteractive(node("process.kill(process.pid, 'SIGTERM')"), {
      stdout: 'pipe',
    });
    expect(killed.signal).toBe('SIGTERM');
    expect(exitCodeOf(killed)).toBe(143);
  });

  it('times out captured commands', async () => {
    const result = await capture(node('setTimeout(() => {}, 10000)'), { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });

  it.skipIf(onWindows)('forwards Ctrl+C to the child', async () => {
    const script = `
      import { runInteractive } from ${JSON.stringify(new URL('../../dist/core/process.js', import.meta.url).href)};
      const status = await runInteractive({ file: process.execPath, args: ['-e', "process.on('SIGINT', () => { console.log('child got SIGINT'); process.exit(5); }); setInterval(() => {}, 1000); console.log('ready')"], cwd: process.cwd(), env: process.env }, { stdout: 'inherit' });
      console.log('parent saw', status.code);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (String(chunk).includes('ready')) child.kill('SIGINT');
    });
    await new Promise((resolve) => child.once('close', resolve));
    expect(output).toContain('child got SIGINT');
    expect(output).toContain('parent saw 5');
  });
});

describe('versions', () => {
  it('compares and classifies', () => {
    expect(compareVersions('4.10.0', '4.9.0')).toBeGreaterThan(0);
    expect(classifyVersion('4.8.9')).toBe('too-old');
    expect(classifyVersion('4.9.0')).toBe('supported');
    expect(classifyVersion('5.0.2')).toBe('supported');
    expect(classifyVersion('6.0.0')).toBe('untested');
    expect(classifyVersion(undefined)).toBe('unknown');
  });
});

describe('theme configuration', () => {
  it('applies [environments.default] implicitly and finds the file upwards', () => {
    const root = core.dir('theme');
    writeFileSync(
      path.join(root, 'shopify.theme.toml'),
      '[environments.default]\nstore = "a"\n[environments.staging]\ntheme = "1"\n',
    );
    expect(resolveThemeEnvironment(core.dir('theme', 'sections'))).toMatchObject({
      name: 'default',
      implicit: true,
    });
    expect(resolveThemeEnvironment(root, 'staging')?.settings).toEqual({ theme: '1' });
    expect(() => resolveThemeEnvironment(root, 'nope')).toThrow(
      expect.objectContaining({ hint: 'It defines: default, staging' }),
    );
  });
});

describe('editor commands', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitWords('code --reuse-window')).toEqual(['code', '--reuse-window']);
    expect(splitWords(`"/Applications/My Editor" -n ''`)).toEqual([
      '/Applications/My Editor',
      '-n',
      '',
    ]);
    expect(() => splitWords('"unclosed')).toThrow();
  });
});
