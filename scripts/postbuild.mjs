import { chmodSync } from 'node:fs';

// tsc does not preserve the executable bit that `npm link` and direct execution rely on.
chmodSync(new URL('../dist/bin.js', import.meta.url), 0o755);
