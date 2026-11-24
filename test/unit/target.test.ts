import { describe, expect, it } from 'vitest';
import {
  findLiveTheme,
  needsLiveConfirmation,
  resolveTarget,
  resolveTheme,
} from '../../src/core/safety/target.js';
import { parseForwarded } from '../../src/core/shopify/flags.js';
import type { ThemeEnvironment } from '../../src/core/theme-config.js';
import { THEMES } from '../helpers/sandbox.js';

const environment = (settings: Record<string, unknown>): ThemeEnvironment => ({
  file: '/x/shopify.theme.toml',
  name: 'default',
  implicit: true,
  settings,
});
const resolve = (argv: string[], workspaceThemeId?: string, settings?: Record<string, unknown>) =>
  resolveTarget({
    flags: parseForwarded('push', argv),
    workspaceThemeId,
    environment: settings === undefined ? undefined : environment(settings),
  });

describe('resolveTarget', () => {
  it('prefers flags, then the workspace, then the environment', () => {
    expect(resolve(['--theme', '1'], '2', { theme: '3' })).toEqual({
      target: { kind: 'theme', ref: '1' },
      origin: 'flag',
    });
    expect(resolve([], '2', { theme: '2' })).toEqual({
      target: { kind: 'theme', ref: '2' },
      origin: 'workspace',
    });
    expect(resolve([], undefined, { theme: '3' })).toEqual({
      target: { kind: 'theme', ref: '3' },
      origin: 'environment',
    });
    expect(resolve([])).toBeUndefined();
  });

  it('understands each kind of target', () => {
    expect(resolve(['-l'])?.target).toEqual({ kind: 'live' });
    expect(resolve(['-d', '-c', 'pr-7'])?.target).toEqual({ kind: 'development', context: 'pr-7' });
    expect(resolve(['-u', '-t', 'New'])?.target).toEqual({ kind: 'unpublished', name: 'New' });
    expect(resolve([], undefined, { live: true })?.target).toEqual({ kind: 'live' });
    expect(resolve([], undefined, { theme: 123 })?.target).toEqual({ kind: 'theme', ref: '123' });
  });

  it.each([
    ['--live with --theme', ['--live', '--theme', '1'], undefined, undefined],
    ['--live with --development', ['--live', '--development'], undefined, undefined],
    ['--development with --unpublished', ['-d', '-u'], undefined, undefined],
    ['a development context without --development', ['-c', 'x'], undefined, undefined],
    [
      '--theme while the TOML says live, which Shopify would let win',
      ['--theme', '1'],
      undefined,
      { live: true },
    ],
    ['--development while the TOML says live', ['--development'], undefined, { live: true }],
    ['a workspace theme while the TOML says live', [], '1', { live: true }],
    ['a workspace theme that disagrees with the TOML', [], '1', { theme: '2' }],
    ['live and theme in one TOML environment', [], undefined, { live: true, theme: '2' }],
    [
      'live and development in one TOML environment',
      [],
      undefined,
      { live: true, development: true },
    ],
    ['several themes in the TOML', [], undefined, { theme: ['1', '2'] }],
  ] as const)('refuses %s', (_label, argv, workspaceThemeId, settings) => {
    expect(() => resolve([...argv], workspaceThemeId, settings)).toThrow(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
  });

  it('accepts a flag that repeats what the TOML says', () => {
    expect(resolve(['--live'], undefined, { live: true })?.target).toEqual({ kind: 'live' });
  });
});

describe('resolveTheme', () => {
  it('matches by ID, hash ID or exact name', () => {
    for (const ref of ['200', '#200', 'staging', 'STAGING'])
      expect(resolveTheme(ref, THEMES, 's').id).toBe('200');
  });

  it('refuses wildcards, duplicates and unknown names', () => {
    expect(() => resolveTheme('Da*', THEMES, 's')).toThrow(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
    expect(() => resolveTheme('Copy', THEMES, 's')).toThrow(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
    expect(() => resolveTheme('Nope', THEMES, 's')).toThrow(
      expect.objectContaining({ code: 'TARGET_NOT_FOUND' }),
    );
  });

  it('refuses an ID that is also another theme’s name', () => {
    const themes = [...THEMES, { id: '900', name: '200', role: 'unpublished' }];
    expect(() => resolveTheme('200', themes, 's')).toThrow(
      expect.objectContaining({ code: 'TARGET_AMBIGUOUS' }),
    );
  });
});

describe('live themes', () => {
  it('finds exactly one', () => {
    expect(findLiveTheme(THEMES, 's').id).toBe('100');
    expect(() => findLiveTheme([], 's')).toThrow();
    expect(() => findLiveTheme([...THEMES, { id: '9', name: 'x', role: 'main' }], 's')).toThrow();
  });

  it('protects roles it does not recognise', () => {
    expect(needsLiveConfirmation({ id: '1', name: 'x', role: 'live' })).toBe(true);
    expect(needsLiveConfirmation({ id: '1', name: 'x', role: 'main' })).toBe(true);
    expect(needsLiveConfirmation({ id: '1', name: 'x', role: 'something-new' })).toBe(true);
    expect(needsLiveConfirmation({ id: '1', name: 'x', role: 'unpublished' })).toBe(false);
  });
});
