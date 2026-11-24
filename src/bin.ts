#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'shell' && args[1] === 'hook') {
  // Runs on every directory change, so it skips the rest of the program.
  const [{ runHook }, { resolvePaths }] = await Promise.all([
    import('./core/shell/hook.js'),
    import('./core/paths.js'),
  ]);
  try {
    const { script, messages } = runHook(resolvePaths(), process.env, process.cwd());
    if (script !== '') process.stdout.write(`${script}\n`);
    if (messages.length > 0 && !process.env.SHOPSHIFT_QUIET)
      process.stderr.write(`${messages.join('\n')}\n`);
  } catch {
    // A prompt hook must never break the prompt.
  }
} else {
  // A closed pipe (`shopshift list | head -1`) is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  const { main } = await import('./cli/program.js');
  await main(args);
}
