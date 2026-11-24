import type { Env } from '../core/paths.js';

export interface Style {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  danger(text: string): string;
  /** Reverse-video badge, reserved for anything customers can see. */
  live(text: string): string;
}

/** Follows NO_COLOR and FORCE_COLOR, then whether the stream is a terminal. */
export function colorEnabled(stream: { isTTY?: boolean }, env: Env = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
  return stream.isTTY === true && env.TERM !== 'dumb';
}

export function createStyle(enabled: boolean): Style {
  const wrap = (open: string, close: string) => (text: string) =>
    enabled && text !== '' ? `\u001b[${open}m${text}\u001b[${close}m` : text;
  return {
    enabled,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    accent: wrap('36', '39'),
    success: wrap('32', '39'),
    warning: wrap('33', '39'),
    danger: wrap('31', '39'),
    live: wrap('1;41;97', '22;49;39'),
  };
}

export const symbols = {
  success: '✓',
  warning: '!',
  error: '✗',
  active: '●',
  inactive: '○',
  arrow: '›',
} as const;
