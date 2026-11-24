import { describe, expect, it } from 'vitest';
import { buildShopifyEnvironment, findEnvironmentConflicts } from '../../src/core/environment.js';

const context = { store: 'tangelo.myshopify.com', alias: 'me@example.test' };

describe('findEnvironmentConflicts', () => {
  it('accepts an environment that agrees with the workspace', () => {
    expect(
      findEnvironmentConflicts(
        {
          SHOPIFY_FLAG_STORE: 'https://tangelo.myshopify.com',
          SHOPIFY_FLAG_AUTH_ALIAS: 'me@example.test',
          SHOPIFY_FLAG_OPEN: '1',
        },
        context,
      ),
    ).toEqual([]);
  });

  it('reports a different store, account, target or credential', () => {
    const conflicts = findEnvironmentConflicts(
      {
        SHOPIFY_FLAG_STORE: 'other',
        SHOPIFY_FLAG_AUTH_ALIAS: 'you@example.test',
        SHOPIFY_FLAG_LIVE: '1',
        SHOPIFY_FLAG_ALLOW_LIVE: '1',
        SHOPIFY_FLAG_PUBLISH: '1',
        SHOPIFY_FLAG_THEME_ID: '1',
        SHOPIFY_CLI_THEME_TOKEN: 'shptka_supersecret',
        SHOPIFY_SERVICE_ACCOUNT_TOKEN: 'atkn_supersecret',
      },
      context,
    );
    expect(conflicts.map((conflict) => conflict.variable)).toEqual([
      'SHOPIFY_CLI_THEME_TOKEN',
      'SHOPIFY_FLAG_ALLOW_LIVE',
      'SHOPIFY_FLAG_AUTH_ALIAS',
      'SHOPIFY_FLAG_LIVE',
      'SHOPIFY_FLAG_PUBLISH',
      'SHOPIFY_FLAG_STORE',
      'SHOPIFY_FLAG_THEME_ID',
      'SHOPIFY_SERVICE_ACCOUNT_TOKEN',
    ]);
    expect(JSON.stringify(conflicts)).not.toContain('supersecret');
  });

  it('treats a flag it has never heard of as a conflict', () => {
    expect(findEnvironmentConflicts({ SHOPIFY_FLAG_BRAND_NEW: '1' }, context)).toHaveLength(1);
  });

  it('ignores what the shell integration exported, even for another workspace', () => {
    expect(
      findEnvironmentConflicts(
        {
          SHOPIFY_FLAG_STORE: 'other',
          SHOPIFY_FLAG_AUTH_ALIAS: 'x',
          SHOPSHIFT_MANAGED: 'SHOPIFY_FLAG_STORE SHOPIFY_FLAG_AUTH_ALIAS',
        },
        context,
      ),
    ).toEqual([]);
  });

  it('cannot be told to ignore a credential or a target', () => {
    const conflicts = findEnvironmentConflicts(
      {
        SHOPIFY_FLAG_LIVE: '1',
        SHOPIFY_CLI_THEME_TOKEN: 'x',
        SHOPSHIFT_MANAGED: 'SHOPIFY_FLAG_LIVE SHOPIFY_CLI_THEME_TOKEN',
      },
      context,
    );
    expect(conflicts).toHaveLength(2);
  });

  it('ignores empty variables and an intended theme token', () => {
    expect(findEnvironmentConflicts({ SHOPIFY_FLAG_STORE: '' }, context)).toEqual([]);
    expect(
      findEnvironmentConflicts(
        { SHOPIFY_CLI_THEME_TOKEN: 'x' },
        { ...context, useThemeToken: true },
      ),
    ).toEqual([]);
  });
});

describe('buildShopifyEnvironment', () => {
  it('drops context, targets and credentials, and keeps everything else', () => {
    const env = buildShopifyEnvironment({
      PATH: '/bin',
      HOME: '/home/me',
      HTTPS_PROXY: 'http://proxy',
      SHOPIFY_HTTP_PROXY: 'http://proxy',
      SHOPIFY_FLAG_VERBOSE: '1',
      SHOPIFY_FLAG_STORE: 'x',
      SHOPIFY_FLAG_AUTH_ALIAS: 'x',
      SHOPIFY_FLAG_FORCE: '1',
      SHOPIFY_FLAG_SOMETHING_NEW: '1',
      SHOPIFY_CLI_THEME_TOKEN: 'secret',
      SHOPIFY_CLI_IDENTITY_TOKEN: 'secret',
    });
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/me',
      HTTPS_PROXY: 'http://proxy',
      SHOPIFY_HTTP_PROXY: 'http://proxy',
      SHOPIFY_FLAG_VERBOSE: '1',
    });
  });

  it('passes a theme token only when asked', () => {
    const env = { SHOPIFY_CLI_THEME_TOKEN: 'token', SHOPIFY_CLI_REFRESH_TOKEN: 'other' };
    expect(buildShopifyEnvironment(env, { useThemeToken: true })).toEqual({
      SHOPIFY_CLI_THEME_TOKEN: 'token',
    });
  });
});
