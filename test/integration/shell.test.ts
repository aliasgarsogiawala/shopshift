import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Sandbox } from '../helpers/sandbox.js';

const BIN = new URL('../../dist/bin.js', import.meta.url).pathname;
const available = (shell: string) =>
  process.platform !== 'win32' && spawnSync(shell, ['-c', 'exit 0']).status === 0;

let box: Sandbox;
let directory: string;
beforeEach(async () => {
  box = new Sandbox();
  directory = await box.seed();
  await box.ok([
    'add',
    'Nori',
    '--store',
    'nori',
    '--account',
    'agency',
    '--dir',
    box.theme('nori'),
  ]);
  // A `shopshift` on PATH, as after `npm install -g`.
  const bin = box.dir('bin');
  writeFileSync(
    path.join(bin, 'shopshift'),
    `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`,
  );
  chmodSync(path.join(bin, 'shopshift'), 0o755);
});
afterEach(() => box.dispose());

function run(shell: 'zsh' | 'bash', script: string, env: Record<string, string> = {}) {
  const bin = path.join(box.root, 'bin');
  const flags = shell === 'zsh' ? ['-f', '-c'] : ['--norc', '--noprofile', '-c'];
  const result = spawnSync(shell, [...flags, script], {
    cwd: box.projects,
    env: { ...box.env, PATH: `${bin}:${box.env.PATH}`, ...env },
    encoding: 'utf8',
  });
  return { ...result, lines: result.stdout.trim().split('\n') };
}

describe.each(['zsh', 'bash'] as const)('%s integration', (shell) => {
  it.runIf(available(shell))('sets the context on cd and clears it on leaving', () => {
    // bash runs PROMPT_COMMAND only at an interactive prompt, so the test calls it the same way.
    const prompt = shell === 'bash' ? '_shopshift_prompt' : ':';
    const result = run(
      shell,
      `eval "$(shopshift shell init ${shell})"
       cd ${JSON.stringify(directory)}/sections; ${prompt}
       echo "in:$SHOPIFY_FLAG_STORE:$SHOPIFY_FLAG_AUTH_ALIAS:$SHOPSHIFT_WORKSPACE"
       cd /; ${prompt}
       echo "out:\${SHOPIFY_FLAG_STORE-unset}:\${SHOPSHIFT_MANAGED-unset}"`,
    );
    expect(result.status).toBe(0);
    expect(result.lines).toEqual([
      'in:tangelo-demo.myshopify.com:me@example.test:tangelo',
      'out:unset:unset',
    ]);
    expect(result.stderr).toContain('shopshift: Tangelo');
  });

  it.runIf(available(shell))(
    'follows "shopshift use" into the project, and keeps the exit status',
    () => {
      const result = run(
        shell,
        `eval "$(shopshift shell init ${shell})"
       shopshift use nori 2>/dev/null
       echo "pwd:$PWD:$SHOPIFY_FLAG_STORE"
       shopshift use missing 2>/dev/null
       echo "status:$?"`,
      );
      expect(result.lines).toEqual([
        `pwd:${path.join(box.projects, 'nori')}:nori.myshopify.com`,
        'status:3',
      ]);
    },
  );

  it.runIf(available(shell))('stays out of the way with --no-cd and SHOPSHIFT_QUIET', () => {
    const result = run(
      shell,
      `eval "$(shopshift shell init ${shell} --no-cd)"
       shopshift use nori
       echo "pwd:$PWD"`,
      { SHOPSHIFT_QUIET: '1' },
    );
    expect(result.lines).toEqual([`pwd:${box.projects}`]);
    expect(result.stderr).not.toContain('shopshift:');
  });

  it.runIf(available(shell))('never overrides a variable the developer exported', () => {
    const result = run(
      shell,
      `export SHOPIFY_FLAG_STORE=mine.myshopify.com
       eval "$(shopshift shell init ${shell})"
       cd ${JSON.stringify(directory)}; ${shell === 'bash' ? '_shopshift_prompt' : ':'}
       cd /; ${shell === 'bash' ? '_shopshift_prompt' : ':'}
       echo "store:$SHOPIFY_FLAG_STORE"`,
    );
    expect(result.lines).toEqual(['store:mine.myshopify.com']);
  });

  it.runIf(available(shell))('preserves $? for the prompt', () => {
    if (shell !== 'bash') return;
    const result = run(
      shell,
      `eval "$(shopshift shell init bash)"; (exit 7); _shopshift_prompt; echo "status:$?"`,
    );
    expect(result.lines).toEqual(['status:7']);
  });
});

it('does not write to any shell configuration file', async () => {
  const before = readdirSync(box.home);
  await box.ok(['shell', 'init', 'zsh']);
  await box.ok(['shell', 'init', 'bash']);
  expect(readdirSync(box.home)).toEqual(before);
  expect((await box.run(['shell', 'init', 'fish'])).code).toBe(2);
});
