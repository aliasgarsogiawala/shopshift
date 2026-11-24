import { describe, expect, it } from 'vitest';
import { buildThemeArgs, CONTEXT_FLAGS, formatCommand } from '../../src/core/shopify/args.js';
import { parseForwarded } from '../../src/core/shopify/flags.js';

describe('parseForwarded', () => {
  it('reads every way oclif lets a value be written', () => {
    for (const argv of [['--theme', '1'], ['--theme=1'], ['-t', '1'], ['-t1'], ['-t=1']]) {
      expect(parseForwarded('push', argv).value('theme')).toBe('1');
    }
  });

  it('expands clustered short flags', () => {
    const flags = parseForwarded('push', ['-nat', '5']);
    expect(flags.has('nodelete')).toBe(true);
    expect(flags.has('allow-live')).toBe(true);
    expect(flags.value('theme')).toBe('5');
    expect(flags.without(['theme'])).toEqual(['--nodelete', '--allow-live']);
  });

  it('treats repeated values as greedy for multi-value options only', () => {
    const flags = parseForwarded('push', ['--only', 'a', 'b', '--nodelete', 'c']);
    expect(flags.values('only')).toEqual(['a', 'b']);
    expect(flags.positionals).toEqual(['c']);
  });

  it('collects unknown flags without losing them', () => {
    const flags = parseForwarded('dev', ['--from-the-future', 'x', '--open']);
    expect(flags.unknown).toEqual(['--from-the-future']);
    expect(flags.positionals).toEqual([]);
    expect(flags.without([])).toEqual(['--from-the-future', 'x', '--open']);
  });

  it('keeps values that look like paths, globs or shell code untouched', () => {
    const argv = ['--only', 'sections/*.liquid', '--ignore', '$(rm -rf ~)', '--notify', 'a b'];
    expect(parseForwarded('dev', argv).without([])).toEqual(argv);
  });

  it('refuses missing values and contradictory repeats', () => {
    expect(() => parseForwarded('push', ['--theme'])).toThrow(/needs a value/);
    expect(() => parseForwarded('push', ['--live=true'])).toThrow(/does not take a value/);
    expect(() => parseForwarded('push', ['-t', '1', '--theme', '2']).value('theme')).toThrow(
      /more than once/,
    );
    expect(parseForwarded('push', ['-t', '1', '--theme', '1']).value('theme')).toBe('1');
  });

  it('recognises flags per command', () => {
    expect(parseForwarded('push', ['--port', '1']).unknown).toEqual(['--port']);
    expect(parseForwarded('dev', ['--port', '1']).unknown).toEqual([]);
    expect(parseForwarded('check', ['-o', 'json']).value('output')).toBe('json');
    expect(parseForwarded('push', ['-o', 'x']).values('only')).toEqual(['x']);
  });
});

describe('buildThemeArgs', () => {
  it('states the whole context explicitly', () => {
    expect(
      buildThemeArgs({
        command: 'dev',
        store: 'a.myshopify.com',
        alias: 'me@example.test',
        environment: 'staging',
        port: 9300,
        rest: ['--open'],
      }),
    ).toEqual([
      'theme',
      'dev',
      '--store',
      'a.myshopify.com',
      '--auth-alias',
      'me@example.test',
      '--environment',
      'staging',
      '--port',
      '9300',
      '--open',
    ]);
  });

  it.each([
    [{ kind: 'theme', ref: '12' }, ['--theme', '12']],
    [{ kind: 'live' }, ['--live']],
    [{ kind: 'development' }, ['--development']],
    [{ kind: 'development', context: 'pr-1' }, ['--development', '--development-context', 'pr-1']],
    [{ kind: 'unpublished', name: 'New' }, ['--unpublished', '--theme', 'New']],
  ] as const)('writes target %j', (target, expected) => {
    expect(buildThemeArgs({ command: 'push', target, rest: [] })).toEqual([
      'theme',
      'push',
      ...expected,
    ]);
  });

  it('leaves out the alias when a token is used', () => {
    const args = buildThemeArgs({ command: 'push', store: 'a.myshopify.com', rest: [] });
    expect(args).not.toContain('--auth-alias');
  });

  it('never duplicates context that was also forwarded', () => {
    const flags = parseForwarded('dev', [
      '-s',
      'a',
      '--port',
      '1',
      '--open',
      '--auth-alias',
      'x',
      '-e',
      'y',
    ]);
    expect(flags.without(CONTEXT_FLAGS)).toEqual(['--open']);
  });

  it('formats commands for display without ambiguity', () => {
    expect(formatCommand(['theme', 'push', '--only', "it's a *"])).toBe(
      `shopify theme push --only 'it'\\''s a *'`,
    );
  });
});
