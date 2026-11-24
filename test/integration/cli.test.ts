import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collect, freePort, occupy, onWindows, Sandbox, waitFor } from '../helpers/sandbox.js';

let box: Sandbox;
beforeEach(() => {
  box = new Sandbox();
});
afterEach(() => box.dispose());

describe('accounts and workspaces', () => {
  it('rejects an alias Shopify CLI does not know', async () => {
    const result = await box.run(['account', 'add', 'Ghost', '--alias', 'ghost@example.test']);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('no session');
  });

  it('finds the workspace from a nested directory', async () => {
    const directory = await box.seed();
    const result = await box.ok(['current', '--json'], { cwd: `${directory}/sections` });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'tangelo',
      source: 'directory',
      alias: 'me@example.test',
    });
  });

  it('keeps every workspace when several are added at once', async () => {
    await box.seed();
    const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    await Promise.all(
      names.map((name) =>
        box.ok(['add', name, '--store', name, '--account', 'agency', '--dir', box.theme(name)]),
      ),
    );
    expect(Object.keys(box.config().workspaces).sort()).toEqual([
      'five',
      'four',
      'one',
      'six',
      'tangelo',
      'three',
      'two',
    ]);
  });

  it('removes a workspace only when told to', async () => {
    await box.seed();
    expect((await box.run(['remove', 'tangelo'])).code).toBe(2);
    await box.ok(['remove', 'tangelo', '--yes']);
    expect(box.config().workspaces).toEqual({});
  });
});

describe('context', () => {
  it('passes the store and account explicitly, and strips conflicting variables', async () => {
    const cwd = await box.seed();
    await box.ok(['themes', '--json'], {
      cwd,
      env: { SHOPIFY_FLAG_STORE: 'evil', SHOPIFY_CLI_THEME_TOKEN: 'shptka_secret' },
    });
    const call = box.themeCalls('list')[0];
    expect(call?.argv.join(' ')).toContain(
      '--store tangelo-demo.myshopify.com --auth-alias me@example.test',
    );
    expect(call?.env.SHOPIFY_FLAG_STORE).toBeUndefined();
    expect(call?.env.SHOPIFY_CLI_THEME_TOKEN).toBeUndefined();
  });

  it('refuses a --store that is not the workspace store', async () => {
    const cwd = await box.seed();
    const result = await box.run(['push', '--store', 'other', '--theme', '200', '--yes'], { cwd });
    expect(result.code).toBe(5);
    expect(box.themeCalls('push')).toHaveLength(0);
  });

  it('propagates exit codes', async () => {
    const cwd = await box.seed({ theme: '200' });
    box.mock('behaviour', { exitCode: 7 });
    expect((await box.run(['pull'], { cwd })).code).toBe(7);
  });

  it.skipIf(onWindows)('ends with the same signal as Shopify CLI', async () => {
    const cwd = await box.seed({ theme: '200' });
    box.mock('behaviour', { signal: 'SIGTERM' });
    expect((await box.run(['pull'], { cwd })).signal).toBe('SIGTERM');
  });
});

describe('push safety', () => {
  const pushed = () => box.themeCalls('push');

  it.each([
    ['no target', ['--yes']],
    ['a live theme with only --yes', ['--live', '--yes']],
    ['a live theme by name', ['--theme', 'Dawn', '--yes']],
    [
      'a live theme with the wrong confirmation',
      ['--live', '--allow-live', '--confirm-live', '200'],
    ],
    ['an ambiguous name', ['--theme', 'Copy', '--yes']],
    ['--publish', ['--theme', '200', '--publish', '--yes']],
    ['an unconfirmed theme', ['--theme', '200']],
  ])('blocks %s', async (_label, args) => {
    const cwd = await box.seed();
    expect((await box.run(['push', ...args], { cwd })).code).not.toBe(0);
    expect(pushed()).toHaveLength(0);
  });

  it('blocks a push while a token or store variable contradicts the workspace', async () => {
    const cwd = await box.seed({ theme: '200' });
    for (const env of [
      { SHOPIFY_FLAG_STORE: 'other' },
      { SHOPIFY_CLI_THEME_TOKEN: 'shptka_secret' },
    ]) {
      const result = await box.run(['push', '--yes'], { cwd, env });
      expect(result.code).toBe(5);
      expect(result.stdout + result.stderr).not.toContain('shptka_secret');
    }
    expect(pushed()).toHaveLength(0);
  });

  it('does not push from outside the workspace on the strength of "active"', async () => {
    await box.seed({ theme: '200' });
    expect((await box.run(['push', '--yes'])).code).toBe(3);
    expect(pushed()).toHaveLength(0);
  });

  it('pins the theme to its ID', async () => {
    const cwd = await box.seed();
    await box.ok(['push', '--theme', 'staging', '--yes', '--nodelete'], { cwd });
    expect(pushed()[0]?.argv.join(' ')).toMatch(/--theme 200.*--nodelete/);
  });

  it('pushes live unattended only with both confirmations', async () => {
    const cwd = await box.seed();
    await box.ok(['push', '--live', '--allow-live', '--confirm-live', '100'], { cwd });
    expect(pushed()[0]?.argv).toContain('100');
  });

  it('shows the plan without pushing on --dry-run', async () => {
    const cwd = await box.seed();
    const result = await box.ok(['push', '--theme', '200', '--dry-run'], { cwd });
    for (const text of ['Tangelo', 'Personal', 'tangelo-demo.myshopify.com', 'Staging'])
      expect(result.stderr).toContain(text);
    expect(pushed()).toHaveLength(0);
  });
});

describe('dev', () => {
  it.skipIf(onWindows)(
    'runs two stores at once, each with its own account and port',
    async () => {
      const first = await box.seed({ port: await freePort() });
      const second = box.theme('nori');
      await box.ok([
        'add',
        'Nori',
        '--store',
        'nori',
        '--account',
        'agency',
        '--dir',
        second,
        '--port',
        String(await freePort()),
      ]);
      const running = [box.start(['dev'], { cwd: first }), box.start(['dev'], { cwd: second })];
      const results = running.map(collect);
      try {
        await waitFor(
          async () =>
            JSON.parse((await box.ok(['status', '--json'])).stdout).running.length === 2 &&
            box.themeCalls('dev').length === 2,
          20_000,
        );
        expect(
          box
            .themeCalls('dev')
            .map((call) => call.argv[call.argv.indexOf('--auth-alias') + 1])
            .sort(),
        ).toEqual(['agency@example.test', 'me@example.test']);
        expect((await box.run(['dev'], { cwd: first })).code).toBe(5);
      } finally {
        for (const child of running) child.kill('SIGTERM');
        await Promise.all(results);
      }
      expect(JSON.parse((await box.ok(['status', '--json'])).stdout).running).toEqual([]);
    },
    40_000,
  );

  it('explains a busy port', async () => {
    const port = await freePort();
    const cwd = await box.seed({ port });
    const release = await occupy(port);
    const result = await box.run(['dev'], { cwd });
    await release();
    expect(result.code).toBe(6);
    expect(result.stderr).toContain(`Port ${port} is already in use`);
    expect(box.themeCalls('dev')).toHaveLength(0);
  });
});

describe('errors', () => {
  it('suggests a command, and reports JSON errors as JSON', async () => {
    expect((await box.run(['lst'])).stderr).toContain('list');
    const result = await box.run(['current', '--json']);
    expect(JSON.parse(result.stdout).error.code).toEqual(expect.any(String));
  });

  it('says how to install Shopify CLI', async () => {
    const result = await box.run(['account', 'add', 'A', '--alias', 'b'], {
      env: { SHOPSHIFT_SHOPIFY_BIN: undefined, PATH: box.home },
    });
    expect(result.code).toBe(127);
  });

  it('never prints a credential in doctor', async () => {
    await box.seed();
    const result = await box.run(['doctor', '--json'], {
      env: { SHOPIFY_CLI_THEME_TOKEN: 'shptka_secret' },
    });
    expect(result.stdout).toContain('SHOPIFY_CLI_THEME_TOKEN');
    expect(result.stdout + result.stderr).not.toContain('shptka_secret');
  });
});
