import { ShopShiftError } from '../errors.js';

export type ThemeCommand = 'dev' | 'pull' | 'push' | 'list' | 'check' | 'info';

interface FlagDefinition {
  name: string;
  char?: string;
  kind: 'boolean' | 'option';
  multiple?: boolean;
}

const bool = (name: string, char?: string): FlagDefinition => ({
  name,
  kind: 'boolean',
  ...(char === undefined ? {} : { char }),
});
const opt = (name: string, char?: string, multiple = false): FlagDefinition => ({
  name,
  kind: 'option',
  multiple,
  ...(char === undefined ? {} : { char }),
});

const GLOBAL = [
  bool('verbose'),
  bool('no-color'),
  bool('no-input'),
  bool('json-schema'),
  opt('auth-alias'),
];
const STORE = [opt('store', 's'), opt('password'), opt('path'), opt('environment', 'e', true)];
const GLOB = [opt('only', 'o', true), opt('ignore', 'x', true)];

/**
 * The flags Shopify CLI 4.9 to 5.0 accepts, taken from its published oclif manifests. `force` is
 * hidden from Shopify's help but accepted, so it has to be recognised to be refused.
 */
const COMMAND_FLAGS: Record<ThemeCommand, readonly FlagDefinition[]> = {
  dev: [
    ...GLOBAL,
    ...STORE,
    ...GLOB,
    bool('allow-live', 'a'),
    opt('error-overlay'),
    bool('force', 'f'),
    opt('host'),
    opt('listing'),
    opt('live-reload'),
    bool('nodelete', 'n'),
    opt('notify'),
    bool('open'),
    bool('poll'),
    opt('port'),
    opt('reconciliation-strategy'),
    bool('standard-events-inspector'),
    opt('store-password'),
    opt('theme', 't'),
    bool('theme-editor-sync'),
  ],
  pull: [
    ...GLOBAL,
    ...STORE,
    ...GLOB,
    bool('development', 'd'),
    bool('force', 'f'),
    bool('json', 'j'),
    bool('live', 'l'),
    bool('nodelete', 'n'),
    opt('theme', 't'),
  ],
  push: [
    ...GLOBAL,
    ...STORE,
    ...GLOB,
    bool('allow-live', 'a'),
    bool('development', 'd'),
    opt('development-context', 'c'),
    bool('force', 'f'),
    bool('json', 'j'),
    opt('listing'),
    bool('live', 'l'),
    bool('nodelete', 'n'),
    bool('publish', 'p'),
    bool('strict'),
    opt('theme', 't'),
    bool('unpublished', 'u'),
  ],
  list: [...GLOBAL, ...STORE, opt('id'), bool('json', 'j'), opt('name'), opt('role')],
  check: [
    ...GLOBAL,
    opt('path'),
    opt('environment', 'e', true),
    bool('auto-correct', 'a'),
    opt('config', 'C'),
    opt('fail-level'),
    bool('init'),
    bool('json', 'j'),
    bool('list'),
    opt('output', 'o'),
    bool('print'),
    bool('version', 'v'),
  ],
  info: [...GLOBAL, ...STORE, bool('development', 'd'), bool('json', 'j'), opt('theme', 't')],
};

export function supportsFlag(command: ThemeCommand, name: string): boolean {
  return COMMAND_FLAGS[command].some((flag) => flag.name === name);
}

interface FlagToken {
  /** Empty for anything that is not a recognised flag. */
  name: string;
  values: string[];
  raw: string[];
}

/** Arguments a developer wants forwarded to Shopify CLI, understood well enough to reason about. */
export class ForwardedArgs {
  constructor(
    readonly command: ThemeCommand,
    private readonly tokens: readonly FlagToken[],
    /** Flags Shopify CLI is not known to accept for this command. */
    readonly unknown: readonly string[],
    readonly positionals: readonly string[],
  ) {}

  has(name: string): boolean {
    return this.tokens.some((token) => token.name === name);
  }

  /** All values given for an option, across repeats. */
  values(name: string): string[] {
    return this.tokens.filter((token) => token.name === name).flatMap((token) => token.values);
  }

  /** The value of a single-value option. Repeating one with different values is refused. */
  value(name: string): string | undefined {
    const distinct = [...new Set(this.values(name))];
    if (distinct.length > 1) {
      throw new ShopShiftError(
        'CONTEXT_CONFLICT',
        `--${name} was given more than once with different values.`,
      );
    }
    return distinct[0];
  }

  /** The original arguments, minus the named flags, ready to append to a Shopify command. */
  without(names: readonly string[]): string[] {
    const excluded = new Set(names);
    return this.tokens.filter((token) => !excluded.has(token.name)).flatMap((token) => token.raw);
  }
}

/**
 * Parses forwarded arguments the way oclif will: `--flag value`, `--flag=value`, `-f value`,
 * `-fvalue`, `-f=value`, clustered booleans such as `-dn`, and greedy multi-value options.
 */
export function parseForwarded(command: ThemeCommand, argv: readonly string[]): ForwardedArgs {
  const definitions = COMMAND_FLAGS[command];
  const byName = new Map(definitions.map((flag) => [flag.name, flag]));
  const byChar = new Map(
    definitions.flatMap((flag) => (flag.char === undefined ? [] : [[flag.char, flag]])),
  );

  const tokens: FlagToken[] = [];
  const unknown: string[] = [];
  const positionals: string[] = [];
  let greedy: FlagToken | undefined;
  /** An unrecognised flag, together with whatever follows it, because it may take a value. */
  const addUnknown = (shown: string, argument: string) => {
    const token: FlagToken = { name: '', values: [], raw: [argument] };
    unknown.push(shown);
    tokens.push(token);
    greedy = token;
  };

  const readOption = (
    flag: FlagDefinition,
    shown: string,
    inline: string | undefined,
    index: number,
  ) => {
    const next = argv[index + 1];
    const value = inline ?? next;
    if (value === undefined || value === '') {
      throw new ShopShiftError('USAGE', `${shown} needs a value.`);
    }
    const raw = inline === undefined ? [argv[index] ?? shown, value] : [argv[index] ?? shown];
    const token: FlagToken = { name: flag.name, values: [value], raw };
    tokens.push(token);
    greedy = flag.multiple === true ? token : undefined;
    return inline === undefined ? index + 1 : index;
  };

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? '';

    if (argument.startsWith('--') && argument.length > 2) {
      const [, name = '', inline] = /^--([^=]+)(?:=(.*))?$/s.exec(argument) ?? [];
      const flag = byName.get(name);
      if (flag === undefined) {
        addUnknown(`--${name}`, argument);
      } else if (flag.kind === 'boolean') {
        if (inline !== undefined)
          throw new ShopShiftError('USAGE', `--${name} does not take a value.`);
        tokens.push({ name, values: [], raw: [argument] });
        greedy = undefined;
      } else {
        index = readOption(flag, `--${name}`, inline, index);
      }
      continue;
    }

    if (argument.startsWith('-') && argument.length > 1 && argument !== '--') {
      let rest = argument.slice(1);
      while (rest !== '') {
        const char = rest.charAt(0);
        const flag = byChar.get(char);
        if (flag === undefined) {
          addUnknown(`-${char}`, `-${rest}`);
          break;
        }
        if (flag.kind === 'option') {
          const attached = rest.slice(1).replace(/^=/, '');
          const inline = rest.length > 1 ? attached : undefined;
          index = readOption(flag, `-${char}`, inline, index);
          const token = tokens.at(-1);
          // Re-emit in long form so that a cluster such as `-dt 123` can be split up safely.
          if (token !== undefined) token.raw = [`--${flag.name}`, ...token.values];
          break;
        }
        tokens.push({ name: flag.name, values: [], raw: [`--${flag.name}`] });
        greedy = undefined;
        rest = rest.slice(1);
      }
      continue;
    }

    if (greedy === undefined) {
      positionals.push(argument);
      tokens.push({ name: '', values: [], raw: [argument] });
    } else {
      greedy.values.push(argument);
      greedy.raw.push(argument);
    }
  }
  return new ForwardedArgs(command, tokens, unknown, positionals);
}
