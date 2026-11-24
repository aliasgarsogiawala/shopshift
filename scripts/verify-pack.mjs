#!/usr/bin/env node
/**
 * Verifies the package exactly as users would get it: packs the tarball, installs it globally into a
 * throwaway prefix, and runs the installed `shopshift` against the mock Shopify CLI.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'shopshift-pack-')));
let failures = 0;

// When this runs from an npm script (prepublishOnly during `npm publish --dry-run`, for example), the
// parent npm passes its settings down as npm_config_* variables. Inheriting dry-run would make the
// nested pack and install do nothing, so nested npm calls get only their own settings and .npmrc.
const npmEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^npm_(config|lifecycle|package)_/i.test(name)),
);

function check(label, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${label}${!condition && detail ? `\n    ${detail}` : ''}`);
  if (!condition) failures++;
}

try {
  // 1. Pack.
  const [packed] = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', root], {
      cwd: project,
      encoding: 'utf8',
      env: npmEnv,
      shell: windows,
    }),
  );
  const files = packed.files.map((file) => file.path);
  console.log(
    `Packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB`,
  );
  for (const required of [
    'package.json',
    'dist/bin.js',
    'dist/index.js',
    'dist/index.d.ts',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'SECURITY.md',
  ]) {
    check(`contains ${required}`, files.includes(required));
  }
  const unexpected = files.filter(
    (file) =>
      !/^(dist\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|SECURITY\.md$)/.test(file),
  );
  check(
    'contains nothing else (no sources, tests or QA files)',
    unexpected.length === 0,
    unexpected.join(', '),
  );

  // 2. Install globally into a private prefix, as `npm install -g shopshift` would.
  const prefix = path.join(root, 'prefix');
  execFileSync(
    npm,
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      path.join(root, packed.filename),
    ],
    {
      stdio: 'inherit',
      env: npmEnv,
      shell: windows,
    },
  );
  const binary = windows
    ? path.join(prefix, 'shopshift.cmd')
    : path.join(prefix, 'bin', 'shopshift');

  // 3. Run the installed command.
  const state = path.join(root, 'mock');
  mkdirSync(state);
  writeFileSync(path.join(state, 'aliases.json'), JSON.stringify(['me@example.test']));
  writeFileSync(
    path.join(state, 'themes.json'),
    JSON.stringify([{ id: '1', name: 'Dawn', role: 'live' }]),
  );
  const projectDir = path.join(root, 'theme');
  for (const dir of ['config', 'layout', 'templates'])
    mkdirSync(path.join(projectDir, dir), { recursive: true });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    SHOPSHIFT_CONFIG_DIR: path.join(root, 'config'),
    SHOPSHIFT_SHOPIFY_BIN: path.join(project, 'test', 'helpers', 'mock-shopify.mjs'),
    MOCK_STATE: state,
    NO_COLOR: '1',
  };
  const run = (...args) => {
    const result = spawnSync(binary, args, {
      cwd: projectDir,
      env,
      encoding: 'utf8',
      shell: windows,
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };

  const version = run('--version');
  check(
    `shopshift --version prints ${packed.version}`,
    version.out.trim() === packed.version,
    version.out,
  );
  check(
    'shopshift --help lists the commands',
    /Multiple stores\. One workspace\./.test(run('--help').out),
  );
  check('account add', run('account', 'add', 'Me', '--alias', 'me@example.test').code === 0);
  check('add', run('add', 'Theme', '--store', 'theme-demo').code === 0);
  const current = run('current', '--field', 'store');
  check(
    'current detects the project',
    current.out.trim() === 'theme-demo.myshopify.com',
    current.out,
  );
  const dry = run('push', '--live', '--dry-run');
  check(
    'push --dry-run shows the live target',
    /LIVE/.test(dry.out) && /--theme 1/.test(dry.out),
    dry.out,
  );
  check('push to live without confirmation is refused', run('push', '--live').code === 5);
  check(
    'shell init zsh prints the integration',
    /add-zsh-hook/.test(run('shell', 'init', 'zsh').out),
  );
  const doctor = run('doctor', '--json');
  check('doctor --json reports', doctor.out.includes('"checks"'), doctor.out);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

if (failures > 0) {
  console.error(`\n${failures} check${failures === 1 ? '' : 's'} failed.`);
  process.exit(1);
}
console.log('\nThe packed CLI installs and runs.');
