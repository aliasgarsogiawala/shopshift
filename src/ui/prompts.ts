import * as clack from '@clack/prompts';
import { CancelledError, ShopShiftError } from '../core/errors.js';

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** Every prompt is drawn on stderr, and every prompt has a flag that makes it unnecessary. */
export class Prompts {
  constructor(readonly interactive: boolean) {}

  intro(title: string): void {
    if (this.interactive) clack.intro(title, { output: process.stderr });
  }

  outro(message: string): void {
    if (this.interactive) clack.outro(message, { output: process.stderr });
  }

  note(message: string, title?: string): void {
    if (this.interactive) clack.note(message, title, { output: process.stderr });
  }

  async select<T extends string>(
    message: string,
    choices: readonly Choice<T>[],
    options: { initial?: T | undefined; alternative: string },
  ): Promise<T> {
    this.require(options.alternative);
    const answer = await clack.select<string>({
      message,
      options: choices.map((choice) => ({
        value: choice.value as string,
        label: choice.label,
        ...(choice.hint === undefined ? {} : { hint: choice.hint }),
      })),
      maxItems: 12,
      output: process.stderr,
      ...(options.initial === undefined ? {} : { initialValue: options.initial as string }),
    });
    return this.unwrap(answer) as T;
  }

  async text(
    message: string,
    options: {
      alternative: string;
      placeholder?: string | undefined;
      initial?: string | undefined;
      optional?: boolean;
      /** Throw to reject the input. The thrown message is shown to the developer. */
      check?: (value: string) => unknown;
    },
  ): Promise<string> {
    this.require(options.alternative);
    const answer = await clack.text({
      message,
      output: process.stderr,
      ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
      ...(options.initial === undefined ? {} : { initialValue: options.initial }),
      validate: (value) => {
        const entered = (value ?? '').trim();
        if (entered === '' && options.optional === true) return undefined;
        try {
          options.check?.(entered);
          return entered === '' ? 'Required' : undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid value';
        }
      },
    });
    return (this.unwrap(answer) ?? '').trim();
  }

  async confirm(
    message: string,
    options: { initial?: boolean; alternative: string },
  ): Promise<boolean> {
    this.require(options.alternative);
    const answer = await clack.confirm({
      message,
      initialValue: options.initial ?? false,
      output: process.stderr,
    });
    return this.unwrap(answer);
  }

  private require(alternative: string): void {
    if (this.interactive) return;
    throw new ShopShiftError('INTERACTIVE_REQUIRED', 'This needs an interactive terminal.', {
      hint: alternative,
    });
  }

  private unwrap<T>(answer: T): Exclude<T, symbol> {
    if (clack.isCancel(answer)) throw new CancelledError();
    return answer as Exclude<T, symbol>;
  }
}
