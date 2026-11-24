import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountManager } from '../../src/core/accounts.js';
import { ConfigStore } from '../../src/core/config/store.js';
import { resolvePaths, type ShopShiftPaths } from '../../src/core/paths.js';
import { WorkspaceManager } from '../../src/core/workspaces.js';

/** The core API against a throwaway configuration directory. */
export function coreSandbox() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'shopshift-core-')));
  const paths: ShopShiftPaths = resolvePaths({ SHOPSHIFT_CONFIG_DIR: path.join(root, 'config') });
  const store = new ConfigStore(paths);
  const dir = (...segments: string[]) => {
    const full = path.join(root, ...segments);
    mkdirSync(full, { recursive: true });
    return full;
  };
  return {
    root,
    paths,
    store,
    accounts: new AccountManager(store),
    workspaces: new WorkspaceManager(store),
    dir,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
