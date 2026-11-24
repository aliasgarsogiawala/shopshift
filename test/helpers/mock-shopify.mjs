#!/usr/bin/env node
/**
 * Stands in for Shopify CLI. It answers only the documented commands ShopShift uses, in the shapes
 * the real CLI produces, and records every invocation. It never opens a network connection.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const state = process.env.MOCK_STATE;
if (!state) throw new Error('MOCK_STATE is required');
const argv = process.argv.slice(2);
const read = (name, fallback) => {
  const file = path.join(state, `${name}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
};
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const has = (name) => argv.includes(`--${name}`);
const behaviour = read('behaviour', {});

appendFileSync(
  path.join(state, 'calls.jsonl'),
  `${JSON.stringify({
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    at: Date.now(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.startsWith('SHOPIFY_')),
    ),
    tty: [
      process.stdin.isTTY === true,
      process.stdout.isTTY === true,
      process.stderr.isTTY === true,
    ],
  })}\n`,
);

const box = (...lines) => {
  const body = lines.map((line) => `│  ${line.padEnd(74)}  │`).join('\n');
  process.stderr.write(`╭─ error ${'─'.repeat(70)}╮\n${body}\n╰${'─'.repeat(78)}╯\n`);
};
const fail = (message, tryMessage) => {
  if (has('json'))
    process.stdout.write(`${JSON.stringify({ error: { type: 'abort', message, tryMessage } })}\n`);
  else box(message, tryMessage ?? '');
  process.exit(1);
};
const aliases = () => read('aliases', []);
const requireAlias = () => {
  const alias = option('auth-alias');
  if (alias !== undefined && !aliases().includes(alias)) {
    fail(`No authenticated account found for alias ${alias}.`, 'Run `shopify auth login` first.');
  }
};
const requireFreshSession = () => {
  const alias = option('auth-alias');
  if (!read('expired', []).includes(alias)) return;
  if (has('no-input')) {
    fail(
      'Authorization is required to continue, but the current environment does not support interactive prompts.',
    );
  }
  writeFileSync(path.join(state, 'expired.json'), '[]');
};

const command = argv.slice(0, 2).join(' ');
switch (argv[0] === 'version' ? 'version' : command) {
  case 'version':
    process.stdout.write(`\n${behaviour.version ?? '5.0.2'}\n`);
    break;

  case 'auth login': {
    if (has('alias')) {
      if (!aliases().includes(option('alias'))) fail('Would have started an interactive login.');
      process.stdout.write(`${JSON.stringify({ status: 'success', alias: option('alias') })}\n`);
      break;
    }
    const signingIn = read('login', undefined);
    if (signingIn !== undefined) {
      writeFileSync(
        path.join(state, 'aliases.json'),
        JSON.stringify([...new Set([...aliases(), signingIn])]),
      );
    }
    if (has('json')) {
      process.stdout.write(
        `${JSON.stringify({ status: 'success', alias: read('pick', signingIn ?? aliases()[0]) })}\n`,
      );
    } else {
      process.stderr.write('✔ Logged in.\n');
    }
    break;
  }

  case 'store auth':
    process.stdout.write(`${JSON.stringify({ sessions: read('store-auth', []) })}\n`);
    break;

  case 'theme check':
    requireAlias();
    process.stdout.write(has('version') ? '4.0.0\n' : 'Theme Check Summary.\n');
    process.exit(has('version') ? 0 : (behaviour.exitCode ?? 0));
    break;

  case 'theme list': {
    requireAlias();
    requireFreshSession();
    const themes = read('themes', []);
    if (!has('json')) process.stdout.write('theme table\n');
    else if (behaviour.legacyJson)
      process.stdout.write(
        JSON.stringify(themes.map((theme) => ({ ...theme, id: Number(theme.id) }))),
      );
    else process.stdout.write(JSON.stringify({ themes }));
    break;
  }

  case 'theme info': {
    requireAlias();
    requireFreshSession();
    const id = read('development-theme', null);
    process.stdout.write(
      JSON.stringify(
        behaviour.legacyJson
          ? { store: option('store'), development_theme_id: id === null ? null : Number(id) }
          : { storeDomain: option('store'), developmentThemeId: id },
      ),
    );
    break;
  }

  case 'theme dev': {
    requireAlias();
    const port = Number(option('port'));
    const stop = (signal) => {
      appendFileSync(path.join(state, 'signals.log'), `${process.pid} ${signal}\n`);
      process.exit(behaviour.devExitCode ?? 0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    setTimeout(() => {
      createServer((_, response) => response.end('ok')).listen(port, '127.0.0.1', () => {
        process.stdout.write(`Serving ${option('store')} on ${port}\n`);
        if (behaviour.devRunMs) setTimeout(() => process.exit(0), behaviour.devRunMs);
      });
    }, behaviour.devStartMs ?? 0);
    break;
  }

  case 'theme push':
  case 'theme pull':
    requireAlias();
    process.stdout.write(`${argv[1]}ed\n`);
    if (behaviour.signal) process.kill(process.pid, behaviour.signal);
    else process.exit(behaviour.exitCode ?? 0);
    break;

  default:
    fail(`Command ${command} not found.`);
}
