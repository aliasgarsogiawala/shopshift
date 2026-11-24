import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quote, runHook } from '../../src/core/shell/hook.js';
import { shellScript } from '../../src/core/shell/scripts.js';
import { coreSandbox } from '../helpers/core.js';

let core: ReturnType<typeof coreSandbox>;
let project: string;
beforeEach(async () => {
  core = coreSandbox();
  project = core.dir('tangelo');
  await core.accounts.add({ name: 'Me', alias: "o'brien@example.test" });
  await core.workspaces.add({
    name: 'Tangelo',
    account: 'me',
    store: 'tangelo',
    directory: project,
  });
});
afterEach(() => core.dispose());

describe('shell hook', () => {
  it('exports the context inside a workspace, quoted', () => {
    const { script, messages } = runHook(core.paths, {}, project);
    expect(script.split('\n')).toEqual([
      "export SHOPSHIFT_WORKSPACE='tangelo'",
      "export SHOPIFY_FLAG_STORE='tangelo.myshopify.com'",
      `export SHOPIFY_FLAG_AUTH_ALIAS='o'\\''brien@example.test'`,
      "export SHOPSHIFT_MANAGED='SHOPSHIFT_WORKSPACE SHOPIFY_FLAG_STORE SHOPIFY_FLAG_AUTH_ALIAS'",
    ]);
    expect(messages[0]).toContain('Tangelo');
  });

  it('does nothing when nothing changed, and cleans up on leaving', () => {
    const inside = {
      SHOPSHIFT_WORKSPACE: 'tangelo',
      SHOPIFY_FLAG_STORE: 'tangelo.myshopify.com',
      SHOPIFY_FLAG_AUTH_ALIAS: "o'brien@example.test",
      SHOPSHIFT_MANAGED: 'SHOPSHIFT_WORKSPACE SHOPIFY_FLAG_STORE SHOPIFY_FLAG_AUTH_ALIAS',
    };
    expect(runHook(core.paths, inside, project)).toEqual({ script: '', messages: [] });
    expect(runHook(core.paths, inside, core.root).script.split('\n')).toEqual([
      'unset SHOPSHIFT_WORKSPACE',
      'unset SHOPIFY_FLAG_STORE',
      'unset SHOPIFY_FLAG_AUTH_ALIAS',
      'unset SHOPSHIFT_MANAGED',
    ]);
  });

  it('never overwrites or removes variables the developer set', () => {
    const own = { SHOPIFY_FLAG_STORE: 'mine.myshopify.com' };
    const entering = runHook(core.paths, own, project);
    expect(entering.script).not.toContain('SHOPIFY_FLAG_STORE=');
    expect(entering.messages.join()).toContain('leaving your own SHOPIFY_FLAG_STORE');
    const leaving = runHook(
      core.paths,
      { ...own, SHOPSHIFT_MANAGED: 'SHOPSHIFT_WORKSPACE SHOPIFY_FLAG_AUTH_ALIAS' },
      core.root,
    );
    expect(leaving.script).not.toContain('SHOPIFY_FLAG_STORE');
  });

  it('only ever touches its own variables, whatever SHOPSHIFT_MANAGED says', () => {
    const { script } = runHook(
      core.paths,
      { SHOPSHIFT_MANAGED: 'PATH HOME; rm -rf ~ $(x) SHOPIFY_FLAG_STORE' },
      core.root,
    );
    expect(script).toBe('unset SHOPIFY_FLAG_STORE\nunset SHOPSHIFT_MANAGED');
  });

  it('stays silent on a broken configuration', () => {
    const paths = { ...core.paths, configFile: `${core.root}/nope.json` };
    expect(runHook(paths, {}, project)).toEqual({ script: '', messages: [] });
  });

  it('quotes anything', () => {
    expect(quote(`a'b"c$d\`e\\f`)).toBe(`'a'\\''b"c$d\`e\\f'`);
  });

  it('prints scripts that only change things when evaluated', () => {
    for (const shell of ['zsh', 'bash'] as const) {
      const script = shellScript(shell, { cd: true });
      expect(script).not.toMatch(/>>|\.zshrc"|\.bashrc"/);
      expect(script).toContain('command shopshift shell hook');
    }
  });
});
