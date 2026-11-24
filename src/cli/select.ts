import type { Config, Workspace } from '../core/config/schema.js';
import {
  ambiguousWorkspace,
  assertDeliberate,
  noWorkspace,
  type SelectionSource,
  selectWorkspace,
} from '../core/detection.js';
import { listWorkspaces } from '../core/workspaces.js';
import type { Choice } from '../ui/prompts.js';
import type { App } from './app.js';

export interface ChosenWorkspace {
  workspace: Workspace;
  source: SelectionSource | 'prompt';
}

/**
 * Picks the workspace a command applies to. `deliberate` is for commands that overwrite files: they
 * refuse to fall back on whichever workspace happened to be active.
 */
export async function chooseWorkspace(
  app: App,
  config: Config,
  command: string,
  reference: string | undefined,
  options: { deliberate?: boolean } = {},
): Promise<ChosenWorkspace> {
  const selection = selectWorkspace(config, app.cwd, reference);
  if (selection.kind === 'none') throw noWorkspace(config);

  const shared =
    selection.kind === 'ambiguous' ||
    (options.deliberate === true && selection.source === 'shared-directory');
  if (shared) {
    if (!app.prompts.interactive) throw ambiguousWorkspace(selection.candidates, command);
    const id = await app.prompts.select(
      'Several workspaces use this directory. Which store?',
      selection.candidates.map((candidate) => workspaceChoice(config, candidate)),
      {
        alternative: `shopshift ${command} -w <workspace>`,
        ...(selection.kind === 'selected' ? { initial: selection.workspace.id } : {}),
      },
    );
    const workspace = selection.candidates.find((candidate) => candidate.id === id);
    if (workspace === undefined) throw ambiguousWorkspace(selection.candidates, command);
    return { workspace, source: 'prompt' };
  }

  if (options.deliberate === true) assertDeliberate(selection, command, app.cwd);
  return { workspace: selection.workspace, source: selection.source };
}

/** For commands that take a workspace as an argument: use it, or ask. */
export async function referenceOrPrompt(
  app: App,
  config: Config,
  reference: string | undefined,
  message: string,
  alternative: string,
): Promise<string> {
  if (reference !== undefined) return reference;
  const workspaces = listWorkspaces(config);
  if (workspaces.length === 0) throw noWorkspace(config);
  return app.prompts.select(
    message,
    workspaces.map((workspace) => workspaceChoice(config, workspace)),
    { alternative, initial: config.activeWorkspace },
  );
}

export function workspaceChoice(config: Config, workspace: Workspace): Choice<string> {
  const account = config.accounts[workspace.account];
  const details = [
    workspace.store.replace('.myshopify.com', ''),
    account?.name ?? workspace.account,
    workspace.environment,
  ];
  return {
    value: workspace.id,
    label: workspace.name,
    hint: details.filter((detail) => detail !== undefined).join(' · '),
  };
}
