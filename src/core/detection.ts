import type { Config, Workspace } from './config/schema.js';
import { ShopShiftError } from './errors.js';
import { displayPath, isWithin, tryRealpath } from './paths.js';
import { getWorkspace, listWorkspaces } from './workspaces.js';

/**
 * Finds the workspaces whose directory contains `cwd`. The deepest directory wins, so a workspace
 * nested inside another takes over within its own folder. Several workspaces can share one
 * directory (one theme, several stores), in which case all of them are returned.
 */
export function detectWorkspaces(config: Config, cwd: string): Workspace[] {
  const here = tryRealpath(cwd) ?? cwd;
  let deepest = -1;
  let matches: Workspace[] = [];
  for (const workspace of listWorkspaces(config)) {
    const directory = tryRealpath(workspace.directory) ?? workspace.directory;
    if (!isWithin(directory, here)) continue;
    if (directory.length > deepest) {
      deepest = directory.length;
      matches = [workspace];
    } else if (directory.length === deepest) {
      matches.push(workspace);
    }
  }
  return matches;
}

/**
 * How a workspace was chosen:
 * - `flag`: named explicitly
 * - `directory`: the only workspace for this directory
 * - `shared-directory`: one of several for this directory, picked because it is the active one
 * - `active`: we are outside every workspace, so the active one is used
 */
export type SelectionSource = 'flag' | 'directory' | 'shared-directory' | 'active';

export type Selection =
  | { kind: 'selected'; workspace: Workspace; source: SelectionSource; candidates: Workspace[] }
  | { kind: 'ambiguous'; candidates: Workspace[] }
  | { kind: 'none' };

export function selectWorkspace(config: Config, cwd: string, reference?: string): Selection {
  if (reference !== undefined) {
    const workspace = getWorkspace(config, reference);
    return { kind: 'selected', workspace, source: 'flag', candidates: [workspace] };
  }
  const candidates = detectWorkspaces(config, cwd);
  const active =
    config.activeWorkspace !== undefined && Object.hasOwn(config.workspaces, config.activeWorkspace)
      ? config.workspaces[config.activeWorkspace]
      : undefined;

  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) {
    return { kind: 'selected', workspace: only, source: 'directory', candidates };
  }
  if (candidates.length > 1) {
    const preferred = candidates.find((workspace) => workspace.id === active?.id);
    return preferred === undefined
      ? { kind: 'ambiguous', candidates }
      : { kind: 'selected', workspace: preferred, source: 'shared-directory', candidates };
  }
  return active === undefined
    ? { kind: 'none' }
    : { kind: 'selected', workspace: active, source: 'active', candidates: [] };
}

/**
 * Commands that overwrite files must not act on a workspace the developer merely used last. They
 * need to be inside its directory, or name it.
 */
export function assertDeliberate(
  selection: Extract<Selection, { kind: 'selected' }>,
  command: string,
  cwd: string,
): void {
  const { workspace, source, candidates } = selection;
  if (source === 'active') {
    throw new ShopShiftError(
      'WORKSPACE_UNRESOLVED',
      `${displayPath(cwd)} is not inside a workspace, so "${command}" will not guess one.`,
      { hint: `To use the active workspace, name it: shopshift ${command} -w ${workspace.id}` },
    );
  }
  if (source === 'shared-directory') {
    throw ambiguousWorkspace(candidates, command);
  }
}

export function ambiguousWorkspace(
  candidates: readonly Workspace[],
  command: string,
): ShopShiftError {
  return new ShopShiftError(
    'WORKSPACE_AMBIGUOUS',
    `${candidates.length} workspaces use this directory, so the target store is ambiguous.`,
    {
      details: candidates.map((workspace) => `${workspace.id} → ${workspace.store}`),
      hint: `Choose one: shopshift ${command} -w ${candidates[0]?.id ?? '<workspace>'}`,
    },
  );
}

export function noWorkspace(config: Config): ShopShiftError {
  const any = Object.keys(config.workspaces).length > 0;
  return new ShopShiftError('WORKSPACE_UNRESOLVED', 'No workspace for this directory.', {
    hint: any
      ? 'Choose one with: shopshift use <workspace>, or add this directory with: shopshift add'
      : 'Create one with: shopshift add',
  });
}
