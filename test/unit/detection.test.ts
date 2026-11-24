import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDeliberate, detectWorkspaces, selectWorkspace } from '../../src/core/detection.js';
import { coreSandbox } from '../helpers/core.js';

let core: ReturnType<typeof coreSandbox>;
beforeEach(async () => {
  core = coreSandbox();
  await core.accounts.add({ name: 'Me', alias: 'me@example.test' });
});
afterEach(() => core.dispose());

const add = (name: string, directory: string) =>
  core.workspaces.add({
    name,
    account: 'me',
    store: name.toLowerCase().replaceAll(' ', '-'),
    directory,
  });

describe('project detection', () => {
  it('matches the directory and everything below it', async () => {
    const root = core.dir('clients', 'tangelo');
    await add('Tangelo', root);
    const config = core.store.read();
    expect(detectWorkspaces(config, root).map((w) => w.id)).toEqual(['tangelo']);
    expect(
      detectWorkspaces(config, core.dir('clients', 'tangelo', 'sections', 'deep')).map((w) => w.id),
    ).toEqual(['tangelo']);
    expect(detectWorkspaces(config, core.dir('clients'))).toEqual([]);
    expect(detectWorkspaces(config, core.dir('clients', 'tangelo-2'))).toEqual([]);
  });

  it('lets the deepest workspace win', async () => {
    await add('Monorepo', core.dir('mono'));
    await add('Theme', core.dir('mono', 'themes', 'main'));
    const config = core.store.read();
    expect(detectWorkspaces(config, core.dir('mono', 'themes', 'main', 'layout'))[0]?.id).toBe(
      'theme',
    );
    expect(detectWorkspaces(config, core.dir('mono', 'apps'))[0]?.id).toBe('monorepo');
  });

  it('sees through symbolic links', async () => {
    const real = core.dir('real');
    const link = path.join(core.root, 'link');
    symlinkSync(real, link);
    await add('Linked', link);
    expect(detectWorkspaces(core.store.read(), real)[0]?.id).toBe('linked');
  });

  it('asks when several stores share one directory, unless one is active', async () => {
    const shared = core.dir('shared');
    await add('US', shared);
    await add('EU', shared);
    let config = core.store.read();
    expect(selectWorkspace(config, shared)).toMatchObject({
      kind: 'selected',
      source: 'shared-directory',
      workspace: { id: 'us' },
    });
    await core.workspaces.use('eu');
    config = core.store.read();
    expect(selectWorkspace(config, shared)).toMatchObject({ workspace: { id: 'eu' } });
    config.activeWorkspace = undefined;
    expect(selectWorkspace(config, shared)).toMatchObject({ kind: 'ambiguous' });
  });

  it('falls back to the active workspace, but not for commands that overwrite', async () => {
    await add('Tangelo', core.dir('tangelo'));
    const outside = core.dir('elsewhere');
    const selection = selectWorkspace(core.store.read(), outside);
    if (selection.kind !== 'selected') throw new Error('expected a selection');
    expect(selection.source).toBe('active');
    expect(() => assertDeliberate(selection, 'push', outside)).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_UNRESOLVED' }),
    );
    const named = selectWorkspace(core.store.read(), outside, 'tangelo');
    if (named.kind !== 'selected') throw new Error('expected a selection');
    expect(() => assertDeliberate(named, 'push', outside)).not.toThrow();
  });
});
