import { getAccount } from './accounts.js';
import type { Config, Workspace } from './config/schema.js';
import type { ConfigStore } from './config/store.js';
import { ShopShiftError } from './errors.js';
import { resolveDirectory } from './paths.js';
import {
  normalizeStore,
  slugify,
  validateEnvironmentName,
  validateName,
  validatePort,
  validateThemeId,
} from './validate.js';

export interface WorkspaceInput {
  name: string;
  account: string;
  store: string;
  directory: string;
  themeId?: string | undefined;
  environment?: string | undefined;
  port?: number | string | undefined;
}

/** `null` clears an optional field; `undefined` leaves it as it is. */
export interface WorkspacePatch {
  name?: string | undefined;
  account?: string | undefined;
  store?: string | undefined;
  directory?: string | undefined;
  themeId?: string | null | undefined;
  environment?: string | null | undefined;
  port?: number | string | null | undefined;
}

/** Most recently used first, then alphabetical. */
export function listWorkspaces(config: Config): Workspace[] {
  return Object.values(config.workspaces).sort(
    (a, b) =>
      (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '') || a.name.localeCompare(b.name),
  );
}

export function findWorkspace(config: Config, reference: string): Workspace | undefined {
  if (Object.hasOwn(config.workspaces, reference)) return config.workspaces[reference];
  const wanted = reference.trim().toLowerCase();
  return listWorkspaces(config).find(
    (workspace) => workspace.id === wanted || workspace.name.toLowerCase() === wanted,
  );
}

export function getWorkspace(config: Config, reference: string): Workspace {
  const workspace = findWorkspace(config, reference);
  if (workspace !== undefined) return workspace;
  const known = listWorkspaces(config).map((item) => item.id);
  const close = known.filter((item) => item.startsWith(reference.toLowerCase()));
  throw new ShopShiftError('WORKSPACE_NOT_FOUND', `No workspace called "${reference}".`, {
    hint:
      known.length === 0
        ? 'Create one with: shopshift add'
        : `${close.length > 0 ? 'Did you mean' : 'Known workspaces'}: ${(close.length > 0 ? close : known).join(', ')}`,
  });
}

export class WorkspaceManager {
  constructor(private readonly store: ConfigStore) {}

  async add(input: WorkspaceInput): Promise<Workspace> {
    const name = validateName(input.name, 'Workspace name');
    const id = slugify(name);
    const directory = resolveDirectory(input.directory);
    const storeDomain = normalizeStore(input.store);
    const optional = {
      ...(input.themeId === undefined ? {} : { themeId: validateThemeId(input.themeId) }),
      ...(input.environment === undefined
        ? {}
        : { environment: validateEnvironmentName(input.environment) }),
      ...(input.port === undefined ? {} : { port: validatePort(input.port) }),
    };
    return this.store.update((config) => {
      if (Object.hasOwn(config.workspaces, id)) {
        throw new ShopShiftError('WORKSPACE_EXISTS', `A workspace called "${id}" already exists.`, {
          hint: `Change it with: shopshift edit ${id}`,
        });
      }
      const workspace: Workspace = {
        id,
        name,
        account: getAccount(config, input.account).id,
        store: storeDomain,
        directory,
        ...optional,
        createdAt: new Date().toISOString(),
      };
      config.workspaces[id] = workspace;
      config.activeWorkspace ??= id;
      return workspace;
    });
  }

  async edit(reference: string, patch: WorkspacePatch): Promise<Workspace> {
    const directory = patch.directory === undefined ? undefined : resolveDirectory(patch.directory);
    return this.store.update((config) => {
      const current = getWorkspace(config, reference);
      const next: Workspace = { ...current };
      if (patch.name !== undefined) {
        next.name = validateName(patch.name, 'Workspace name');
        next.id = slugify(next.name);
        if (next.id !== current.id && Object.hasOwn(config.workspaces, next.id)) {
          throw new ShopShiftError(
            'WORKSPACE_EXISTS',
            `A workspace called "${next.id}" already exists.`,
          );
        }
      }
      if (patch.account !== undefined) next.account = getAccount(config, patch.account).id;
      if (patch.store !== undefined) {
        next.store = normalizeStore(patch.store);
        // A theme ID only means something on the store it was read from.
        if (next.store !== current.store && patch.themeId === undefined) delete next.themeId;
      }
      if (directory !== undefined) next.directory = directory;
      if (patch.themeId === null) delete next.themeId;
      else if (patch.themeId !== undefined) next.themeId = validateThemeId(patch.themeId);
      if (patch.environment === null) delete next.environment;
      else if (patch.environment !== undefined)
        next.environment = validateEnvironmentName(patch.environment);
      if (patch.port === null) delete next.port;
      else if (patch.port !== undefined) next.port = validatePort(patch.port);

      if (next.id !== current.id) {
        delete config.workspaces[current.id];
        if (config.activeWorkspace === current.id) config.activeWorkspace = next.id;
      }
      config.workspaces[next.id] = next;
      return next;
    });
  }

  /** Forgets the workspace. Local files and the remote store are never touched. */
  async remove(reference: string): Promise<Workspace> {
    return this.store.update((config) => {
      const workspace = getWorkspace(config, reference);
      delete config.workspaces[workspace.id];
      if (config.activeWorkspace === workspace.id) delete config.activeWorkspace;
      return workspace;
    });
  }

  async use(reference: string): Promise<Workspace> {
    return this.store.update((config) => {
      const workspace = getWorkspace(config, reference);
      workspace.lastUsedAt = new Date().toISOString();
      config.activeWorkspace = workspace.id;
      return workspace;
    });
  }

  async touch(id: string): Promise<void> {
    await this.store.update((config) => {
      const workspace = Object.hasOwn(config.workspaces, id) ? config.workspaces[id] : undefined;
      if (workspace !== undefined) workspace.lastUsedAt = new Date().toISOString();
    });
  }
}
