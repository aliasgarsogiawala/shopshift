import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIntegrityIssues } from '../../src/core/config/schema.js';
import { coreSandbox } from '../helpers/core.js';

let core: ReturnType<typeof coreSandbox>;
beforeEach(() => {
  core = coreSandbox();
});
afterEach(() => core.dispose());

async function seed() {
  await core.accounts.add({ name: 'Personal', alias: 'me@example.test' });
  await core.accounts.add({ name: 'Agency', alias: 'agency@example.test' });
  return core.workspaces.add({
    name: 'Tangelo',
    account: 'personal',
    store: 'tangelo',
    directory: core.dir('tangelo'),
  });
}

describe('config persistence', () => {
  it('starts empty and saves what is added', async () => {
    expect(core.store.exists()).toBe(false);
    expect(core.store.read().workspaces).toEqual({});
    const workspace = await seed();
    expect(workspace).toMatchObject({
      id: 'tangelo',
      store: 'tangelo.myshopify.com',
      account: 'personal',
    });
    const saved = JSON.parse(readFileSync(core.paths.configFile, 'utf8'));
    expect(saved).toMatchObject({
      version: 1,
      activeWorkspace: 'tangelo',
      defaultAccount: 'personal',
    });
    expect(Object.keys(saved.accounts)).toEqual(['personal', 'agency']);
  });

  it('keeps a backup of the previous version', async () => {
    await seed();
    await core.workspaces.remove('tangelo');
    expect(
      JSON.parse(readFileSync(core.paths.backupFile, 'utf8')).workspaces.tangelo,
    ).toBeDefined();
  });

  it('does not lose updates made concurrently', async () => {
    await seed();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        core.workspaces.add({
          name: `Store ${index}`,
          account: 'agency',
          store: `store-${index}`,
          directory: core.root,
        }),
      ),
    );
    expect(Object.keys(core.store.read().workspaces)).toHaveLength(13);
  });

  it('explains a broken file instead of overwriting it', async () => {
    await seed();
    writeFileSync(core.paths.configFile, '{ "version": 1, ');
    expect(() => core.store.read()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    await expect(core.workspaces.remove('tangelo')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    expect(readFileSync(core.paths.configFile, 'utf8')).toBe('{ "version": 1, ');
  });

  it('rejects invalid values written by hand', () => {
    core.dir('config');
    writeFileSync(
      core.paths.configFile,
      JSON.stringify({
        version: 1,
        accounts: {},
        workspaces: {
          x: {
            id: 'x',
            name: 'X',
            account: 'a',
            store: 'evil.example',
            directory: 'relative',
            createdAt: 'now',
          },
        },
      }),
    );
    expect(() => core.store.read()).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('refuses a configuration from a newer version', () => {
    core.dir('config');
    writeFileSync(core.paths.configFile, JSON.stringify({ version: 99 }));
    expect(() => core.store.read()).toThrow(expect.objectContaining({ code: 'CONFIG_VERSION' }));
  });

  it('keeps fields it does not know about', async () => {
    await seed();
    const raw = JSON.parse(readFileSync(core.paths.configFile, 'utf8'));
    raw.workspaces.tangelo.futureField = 'kept';
    writeFileSync(core.paths.configFile, JSON.stringify(raw));
    await core.workspaces.touch('tangelo');
    expect(
      JSON.parse(readFileSync(core.paths.configFile, 'utf8')).workspaces.tangelo.futureField,
    ).toBe('kept');
  });
});

describe('accounts', () => {
  it('refuses duplicate names and aliases', async () => {
    await seed();
    await expect(
      core.accounts.add({ name: 'personal', alias: 'x@example.test' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
    await expect(
      core.accounts.add({ name: 'Other', alias: 'me@example.test' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });

  it('will not remove an account a workspace depends on', async () => {
    await seed();
    await expect(core.accounts.remove('personal')).rejects.toMatchObject({
      code: 'ACCOUNT_IN_USE',
    });
    await core.accounts.remove('agency');
    expect(Object.keys(core.store.read().accounts)).toEqual(['personal']);
  });

  it('moves the default when the default account is removed', async () => {
    await core.accounts.add({ name: 'A', alias: 'a@example.test' });
    await core.accounts.add({ name: 'B', alias: 'b@example.test' });
    await core.accounts.remove('a');
    expect(core.store.read().defaultAccount).toBe('b');
  });

  it('relinks to a new alias', async () => {
    await seed();
    await core.accounts.relink('personal', 'new@example.test');
    expect(core.store.read().accounts.personal?.alias).toBe('new@example.test');
    await expect(core.accounts.relink('personal', 'agency@example.test')).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
  });
});

describe('workspaces', () => {
  it('validates everything it stores', async () => {
    await seed();
    const base = { name: 'X', account: 'personal', store: 'x', directory: core.root };
    await expect(core.workspaces.add({ ...base, account: 'nobody' })).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_FOUND',
    });
    await expect(core.workspaces.add({ ...base, store: 'x.com' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      core.workspaces.add({ ...base, directory: `${core.root}/missing` }),
    ).rejects.toMatchObject({
      code: 'DIRECTORY_INVALID',
    });
    await expect(core.workspaces.add({ ...base, port: 80_000 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(core.workspaces.add({ ...base, name: 'Tangelo' })).rejects.toMatchObject({
      code: 'WORKSPACE_EXISTS',
    });
  });

  it('renames, keeps the active pointer, and clears a theme that belonged to another store', async () => {
    await seed();
    await core.workspaces.edit('tangelo', { themeId: '123' });
    const renamed = await core.workspaces.edit('tangelo', {
      name: 'Tangelo EU',
      store: 'tangelo-eu',
    });
    const config = core.store.read();
    expect(renamed.id).toBe('tangelo-eu');
    expect(config.activeWorkspace).toBe('tangelo-eu');
    expect(config.workspaces['tangelo-eu']?.themeId).toBeUndefined();
    expect(config.workspaces.tangelo).toBeUndefined();
  });

  it('clears optional fields with null', async () => {
    await seed();
    await core.workspaces.edit('tangelo', { port: 9300, environment: 'staging' });
    await core.workspaces.edit('tangelo', { port: null, environment: null });
    expect(core.store.read().workspaces.tangelo).not.toHaveProperty('port');
  });

  it('finds workspaces by name, case-insensitively', async () => {
    await seed();
    expect((await core.workspaces.use('TANGELO')).id).toBe('tangelo');
    await expect(core.workspaces.use('tang')).rejects.toMatchObject({
      hint: 'Did you mean: tangelo',
    });
  });

  it('reports integrity problems with a fix', async () => {
    await seed();
    const config = core.store.read();
    const workspace = config.workspaces.tangelo;
    if (workspace === undefined) throw new Error('seed failed');
    config.workspaces.tangelo = { ...workspace, account: 'gone' };
    config.activeWorkspace = 'also-gone';
    const issues = findIntegrityIssues(config);
    expect(issues.map((issue) => issue.fix).join('\n')).toMatch(/shopshift/);
    expect(issues).toHaveLength(2);
  });
});
