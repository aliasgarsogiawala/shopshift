import type { Account, Workspace } from '../config/schema.js';
import { ShopShiftError } from '../errors.js';
import type { RemoteTheme } from '../shopify/client.js';
import {
  findLiveTheme,
  isLive,
  needsLiveConfirmation,
  type ResolvedTarget,
  resolveTheme,
  type TargetOrigin,
  type ThemeTarget,
} from './target.js';

export interface PushPlan {
  workspace: Workspace;
  account: Account;
  /** How Shopify will authenticate, as it should be described to the developer. */
  authentication: string;
  store: string;
  directory: string;
  environment: string | undefined;
  /** What is passed to Shopify. An existing theme is always named by ID, never by name or role. */
  target: ThemeTarget;
  origin: TargetOrigin | 'prompt';
  theme: RemoteTheme | undefined;
  live: boolean;
  /** Level of confirmation ShopShift asks for before starting. */
  confirmation: 'none' | 'standard' | 'live';
}

export interface PushPlanInput {
  workspace: Workspace;
  account: Account;
  authentication: string;
  directory: string;
  environment: string | undefined;
  requested: ResolvedTarget | { target: ThemeTarget; origin: 'prompt' };
  themes: readonly RemoteTheme[];
  developmentThemeId: string | undefined;
}

export function planPush(input: PushPlanInput): PushPlan {
  const { target } = input.requested;
  const base = {
    workspace: input.workspace,
    account: input.account,
    authentication: input.authentication,
    store: input.workspace.store,
    directory: input.directory,
    environment: input.environment,
    origin: input.requested.origin,
  };

  if (target.kind === 'unpublished') {
    return { ...base, target, theme: undefined, live: false, confirmation: 'standard' };
  }

  if (target.kind === 'development') {
    // Shopify looks the development theme up by a remembered ID and does not check its role, so
    // make sure that ID has not become something customers can see.
    const theme =
      target.context === undefined
        ? input.themes.find((candidate) => candidate.id === input.developmentThemeId)
        : undefined;
    if (theme !== undefined && theme.role !== 'development') {
      return { ...base, ...existing(theme) };
    }
    return { ...base, target, theme, live: false, confirmation: 'none' };
  }

  const theme =
    target.kind === 'live'
      ? findLiveTheme(input.themes, base.store)
      : resolveTheme(target.ref, input.themes, base.store);
  return { ...base, ...existing(theme) };
}

function existing(
  theme: RemoteTheme,
): Pick<PushPlan, 'target' | 'theme' | 'live' | 'confirmation'> {
  return {
    target: { kind: 'theme', ref: theme.id },
    theme,
    live: isLive(theme),
    confirmation: needsLiveConfirmation(theme) ? 'live' : 'standard',
  };
}

export interface ConfirmationInput {
  interactive: boolean;
  yes: boolean;
  /** Value of --confirm-live. */
  confirmLive: string | undefined;
  /** Whether Shopify's own --allow-live was passed explicitly. */
  allowLive: boolean;
}

export type ConfirmationDecision = 'proceed' | 'ask' | 'ask-live';

/**
 * Decides whether a plan may go ahead, needs a prompt, or must stop. `--yes` never covers a live
 * theme: unattended live pushes have to name the theme they expect to change.
 */
export function decideConfirmation(plan: PushPlan, input: ConfirmationInput): ConfirmationDecision {
  if (plan.confirmation === 'live') {
    const id = plan.theme?.id ?? '';
    if (input.confirmLive !== undefined) {
      if (input.confirmLive.replace(/^#/, '') !== id) {
        throw new ShopShiftError(
          'LIVE_NOT_CONFIRMED',
          `--confirm-live ${input.confirmLive} does not match the target theme #${id}.`,
          { hint: 'Check that this is the store and theme you meant.' },
        );
      }
      if (!input.interactive && !input.allowLive) {
        throw new ShopShiftError(
          'LIVE_NOT_CONFIRMED',
          'Shopify CLI also needs --allow-live to run unattended.',
          {
            hint: `Add: --allow-live --confirm-live ${id}`,
          },
        );
      }
      return 'proceed';
    }
    if (input.interactive) return 'ask-live';
    throw new ShopShiftError(
      'LIVE_NOT_CONFIRMED',
      `Theme #${id} is live on ${plan.store}. Nothing was pushed.`,
      {
        hint: `To do this unattended, add: --allow-live --confirm-live ${id}`,
      },
    );
  }
  if (plan.confirmation === 'none' || input.yes) return 'proceed';
  if (input.interactive) return 'ask';
  throw new ShopShiftError('NOT_CONFIRMED', 'This push needs confirmation.', {
    hint: 'Add --yes to confirm it.',
  });
}
