import { describe, expect, it } from 'vitest';
import type { Account, Workspace } from '../../src/core/config/schema.js';
import { decideConfirmation, planPush } from '../../src/core/safety/push.js';
import type { ThemeTarget } from '../../src/core/safety/target.js';
import { THEMES } from '../helpers/sandbox.js';

const workspace: Workspace = {
  id: 'tangelo',
  name: 'Tangelo',
  account: 'me',
  store: 'tangelo.myshopify.com',
  directory: '/x',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const account: Account = {
  id: 'me',
  name: 'Me',
  alias: 'me@example.test',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const plan = (target: ThemeTarget, developmentThemeId?: string, themes = THEMES) =>
  planPush({
    workspace,
    account,
    authentication: account.alias,
    directory: '/x',
    environment: undefined,
    requested: { target, origin: 'flag' },
    themes,
    developmentThemeId,
  });
const answer = (overrides: object = {}) => ({
  interactive: true,
  yes: false,
  confirmLive: undefined,
  allowLive: false,
  ...overrides,
});

describe('planPush', () => {
  it('pins every existing theme to its ID', () => {
    expect(plan({ kind: 'theme', ref: 'staging' })).toMatchObject({
      target: { kind: 'theme', ref: '200' },
      live: false,
      confirmation: 'standard',
    });
    expect(plan({ kind: 'live' })).toMatchObject({
      target: { kind: 'theme', ref: '100' },
      live: true,
      confirmation: 'live',
    });
  });

  it('notices that a named theme is live', () => {
    expect(plan({ kind: 'theme', ref: 'Dawn' })).toMatchObject({
      live: true,
      confirmation: 'live',
    });
  });

  it('lets the development theme through without a prompt', () => {
    expect(plan({ kind: 'development' }, '300')).toMatchObject({
      confirmation: 'none',
      theme: { id: '300' },
    });
    expect(plan({ kind: 'development' })).toMatchObject({ confirmation: 'none', theme: undefined });
  });

  it('does not trust a remembered development theme that has become live', () => {
    const themes = THEMES.map((theme) => (theme.id === '300' ? { ...theme, role: 'live' } : theme));
    expect(plan({ kind: 'development' }, '300', themes)).toMatchObject({
      target: { kind: 'theme', ref: '300' },
      live: true,
      confirmation: 'live',
    });
  });

  it('asks before creating a theme', () => {
    expect(plan({ kind: 'unpublished', name: 'New' })).toMatchObject({
      confirmation: 'standard',
      live: false,
    });
  });
});

describe('decideConfirmation', () => {
  const live = plan({ kind: 'live' });
  const staging = plan({ kind: 'theme', ref: '200' });

  it('asks for a live theme even with --yes', () => {
    expect(decideConfirmation(live, answer({ yes: true }))).toBe('ask-live');
    expect(() => decideConfirmation(live, answer({ yes: true, interactive: false }))).toThrow(
      expect.objectContaining({ code: 'LIVE_NOT_CONFIRMED' }),
    );
  });

  it('needs both confirmations to push live unattended', () => {
    expect(() =>
      decideConfirmation(live, answer({ interactive: false, allowLive: true })),
    ).toThrow();
    expect(() =>
      decideConfirmation(live, answer({ interactive: false, confirmLive: '100' })),
    ).toThrow(/--allow-live/);
    expect(
      decideConfirmation(live, answer({ interactive: false, confirmLive: '100', allowLive: true })),
    ).toBe('proceed');
  });

  it('refuses a confirmation for a different theme', () => {
    expect(() => decideConfirmation(live, answer({ confirmLive: '200', allowLive: true }))).toThrow(
      /does not match/,
    );
  });

  it('handles ordinary themes', () => {
    expect(decideConfirmation(staging, answer())).toBe('ask');
    expect(decideConfirmation(staging, answer({ yes: true, interactive: false }))).toBe('proceed');
    expect(() => decideConfirmation(staging, answer({ interactive: false }))).toThrow(
      expect.objectContaining({ code: 'NOT_CONFIRMED' }),
    );
    expect(decideConfirmation(plan({ kind: 'development' }), answer({ interactive: false }))).toBe(
      'proceed',
    );
  });
});
