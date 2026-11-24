import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../helpers/sandbox.js';

let box: Sandbox;
beforeEach(() => {
  box = new Sandbox();
});
afterEach(() => box.dispose());

describe('sessions', () => {
  it('reports an expired session without opening a browser when it cannot ask', async () => {
    const cwd = await box.seed();
    box.mock('expired', ['me@example.test']);
    const result = await box.run(['push', '--theme', '200', '--yes'], { cwd });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('shopshift account login personal');
    expect(box.themeCalls('push')).toHaveLength(0);
    expect(box.calls().filter((call) => call.argv[0] === 'auth')).toHaveLength(0);
  });

  it('uses each account for its own workspace, never the global one', async () => {
    const cwd = await box.seed();
    const other = box.theme('nori');
    await box.ok(['add', 'Nori', '--store', 'nori', '--account', 'agency', '--dir', other]);
    box.resetCalls();
    await box.ok(['themes'], { cwd });
    await box.ok(['themes'], { cwd: other });
    const aliases = box
      .themeCalls('list')
      .map((call) => call.argv[call.argv.indexOf('--auth-alias') + 1]);
    expect(aliases).toEqual(['me@example.test', 'agency@example.test']);
    expect(box.calls().some((call) => call.argv[0] === 'auth')).toBe(false);
  });

  it('switches Shopify CLI only when asked', async () => {
    await box.seed();
    await box.ok(['account', 'use', 'agency', '--no-global']);
    expect(box.calls().some((call) => call.argv[0] === 'auth')).toBe(false);
    await box.ok(['account', 'use', 'agency']);
    const login = box.calls().find((call) => call.argv[0] === 'auth');
    expect(login?.argv).toEqual([
      'auth',
      'login',
      '--alias',
      'agency@example.test',
      '--json',
      '--no-input',
    ]);
    // An exported alias must not change which account `auth login --alias` selects.
    expect(login?.env.SHOPIFY_FLAG_AUTH_ALIAS).toBeUndefined();
  });

  it('removes a profile without signing anyone out', async () => {
    await box.seed();
    await box.ok(['account', 'remove', 'agency', '--yes']);
    expect(box.calls().some((call) => call.argv.includes('logout'))).toBe(false);
    expect((await box.run(['account', 'remove', 'personal', '--yes'])).code).toBe(1);
  });

  it('checks sessions on request', async () => {
    await box.seed();
    box.mock('aliases', ['agency@example.test']);
    const result = await box.ok(['account', 'list', '--check', '--json']);
    const accounts: { id: string; session: string }[] = JSON.parse(result.stdout).accounts;
    expect(Object.fromEntries(accounts.map((account) => [account.id, account.session]))).toEqual({
      personal: 'missing',
      agency: 'available',
    });
  });

  it('supports the Shopify CLI 4.x JSON shapes', async () => {
    const cwd = await box.seed();
    box.mock('behaviour', { version: '4.9.4', legacyJson: true });
    await box.ok(['push', '--theme', 'staging', '--yes'], { cwd });
    expect(box.themeCalls('push')[0]?.argv).toContain('200');
  });

  it('refuses a Shopify CLI that is too old', async () => {
    const cwd = await box.seed();
    box.mock('behaviour', { version: '3.80.0' });
    // As after an upgrade or downgrade: the remembered version belongs to the previous install.
    rmSync(path.join(box.configDir, 'state', 'shopify-version.json'), { force: true });
    const result = await box.run(['themes'], { cwd });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/3\.80\.0/);
  });
});

describe('check', () => {
  it('runs without a store or an account', async () => {
    const cwd = await box.seed();
    await box.ok(['check', '--fail-level', 'error'], { cwd });
    const call = box.themeCalls('check')[0];
    expect(call?.argv).toEqual(['theme', 'check', '--fail-level', 'error']);
    expect(call?.cwd).toBe(cwd);
  });
});
