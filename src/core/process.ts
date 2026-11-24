import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:os';
import { isNodeError, ShopShiftError } from './errors.js';

export interface Command {
  /** Executable path. Never passed through a shell, so arguments need no quoting. */
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CapturedOutput extends ExitStatus {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The developer pressed Ctrl+C while it was running. */
  interrupted: boolean;
}

export function exitCodeOf(status: ExitStatus): number {
  if (status.code !== null) return status.code;
  return status.signal === null ? 1 : 128 + (constants.signals[status.signal] ?? 0);
}

/**
 * Runs a command that owns the terminal. The child inherits stdin, stdout and stderr, so prompts,
 * colours, raw key handling and live output behave exactly as if it had been run directly.
 */
export async function runInteractive(
  command: Command,
  options: { onSpawn?: (child: ChildProcess) => void; stdout?: 'inherit' | 'pipe' } = {},
): Promise<ExitStatus & { stdout: string }> {
  const child = spawn(command.file, [...command.args], {
    cwd: command.cwd,
    env: command.env,
    stdio: ['inherit', options.stdout ?? 'inherit', 'inherit'],
    shell: false,
    windowsHide: false,
  });

  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));

  const stopForwarding = forwardSignals(child);
  try {
    if (child.pid !== undefined) options.onSpawn?.(child);
    const status = await waitForExit(child, command.file);
    return { ...status, stdout: Buffer.concat(chunks).toString('utf8') };
  } finally {
    stopForwarding();
  }
}

/** Runs a short command in the background and collects its output. */
export async function capture(
  command: Command,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<CapturedOutput> {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const child = spawn(command.file, [...command.args], {
    cwd: command.cwd,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let size = 0;
  const collect = (into: Buffer[]) => (chunk: Buffer) => {
    size += chunk.length;
    if (size <= maxBytes) into.push(chunk);
  };
  child.stdout?.on('data', collect(stdout));
  child.stderr?.on('data', collect(stderr));

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  }, options.timeoutMs ?? 60_000);

  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', onInterrupt);
  const stopForwarding = forwardSignals(child);
  try {
    const status = await waitForExit(child, command.file);
    return {
      ...status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      interrupted,
    };
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onInterrupt);
    stopForwarding();
  }
}

/**
 * Keeps ShopShift alive until its child has finished handling a signal.
 *
 * When the terminal is interactive, Ctrl+C reaches the whole foreground process group, so the child
 * has already been signalled and must not receive it twice. Otherwise ShopShift is the only one that
 * got it and has to pass it on.
 */
function forwardSignals(child: ChildProcess): () => void {
  const signals: NodeJS.Signals[] =
    process.platform === 'win32'
      ? ['SIGINT', 'SIGBREAK']
      : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
  const handlers = signals.map((signal) => {
    const fromTerminal = signal === 'SIGINT' || signal === 'SIGQUIT';
    const handler = () => {
      if (fromTerminal && process.stdin.isTTY) return;
      child.kill(signal);
    };
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => {
    for (const remove of handlers) remove();
  };
}

function waitForExit(child: ChildProcess, file: string): Promise<ExitStatus> {
  return new Promise((resolve, reject) => {
    child.once('error', (error) => reject(spawnFailure(error, file)));
    // `close` rather than `exit`: output pipes are fully drained by then.
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function spawnFailure(error: Error, file: string): ShopShiftError {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return new ShopShiftError('SHOPIFY_NOT_FOUND', `Could not run ${file}.`, {
      hint: 'Check that the program and the project directory both exist.',
      cause: error,
    });
  }
  return new ShopShiftError('SHOPIFY_FAILED', `Could not run ${file}: ${error.message}`, {
    cause: error,
  });
}
