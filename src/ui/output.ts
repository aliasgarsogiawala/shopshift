import type { Env } from '../core/paths.js';
import { colorEnabled, createStyle, type Style, symbols } from './style.js';

interface Stream {
  write(text: string): unknown;
  isTTY?: boolean;
}

/**
 * Results go to stdout. Everything said along the way goes to stderr, so that output can be piped
 * and so that forwarded commands keep stdout entirely to themselves.
 */
export class Output {
  /** For text written to stdout. */
  readonly style: Style;
  /** For text written to stderr. */
  readonly note: Style;

  constructor(
    private readonly stdout: Stream = process.stdout,
    private readonly stderr: Stream = process.stderr,
    private readonly env: Env = process.env,
  ) {
    this.style = createStyle(colorEnabled(stdout, env));
    this.note = createStyle(colorEnabled(stderr, env));
  }

  print(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  json(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }

  say(text = ''): void {
    this.stderr.write(`${text}\n`);
  }

  success(text: string): void {
    this.say(`${this.note.success(symbols.success)} ${text}`);
  }

  info(text: string): void {
    this.say(this.note.dim(text));
  }

  warn(text: string): void {
    this.say(`${this.note.warning(symbols.warning)} ${text}`);
  }

  error(
    message: string,
    options: { details?: readonly string[]; hint?: string | undefined } = {},
  ): void {
    this.say(`${this.note.danger(symbols.error)} ${message}`);
    for (const detail of options.details ?? []) {
      for (const line of detail.split('\n')) this.say(`  ${this.note.dim(line)}`);
    }
    if (options.hint !== undefined)
      this.say(`  ${this.note.accent(symbols.arrow)} ${options.hint}`);
  }

  /** Shows a spinner on a terminal, and nothing at all elsewhere. */
  async working<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.stderr.isTTY !== true || !this.note.enabled || this.env.CI) return task();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frame = 0;
    const draw = () => {
      this.stderr.write(
        `\r\u001b[2K${this.note.accent(frames[frame] ?? '')} ${this.note.dim(label)}`,
      );
      frame = (frame + 1) % frames.length;
    };
    const showCursor = () => this.stderr.write('\u001b[?25h');
    this.stderr.write('\u001b[?25l');
    draw();
    const timer = setInterval(draw, 80);
    process.once('exit', showCursor);
    try {
      return await task();
    } finally {
      clearInterval(timer);
      process.off('exit', showCursor);
      this.stderr.write('\r\u001b[2K');
      showCursor();
    }
  }
}

/** Pads by visible characters, ignoring colour codes. */
export function pad(text: string, width: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI colour sequences.
  const visible = [...text.replace(/\u001b\[[0-9;]*m/g, '')].length;
  return text + ' '.repeat(Math.max(0, width - visible));
}

export function columnWidth(values: readonly string[], minimum = 0): number {
  return Math.max(minimum, ...values.map((value) => [...value].length));
}

export function fields(
  rows: readonly (readonly [label: string, value: string])[],
  style: Style,
): string[] {
  const width = columnWidth(rows.map(([label]) => label)) + 2;
  return rows.map(([label, value]) => `  ${style.dim(pad(label, width))}${value}`);
}

export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (iso === undefined) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return 'unknown';
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [86_400 * 30, 'month'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, unit] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}
