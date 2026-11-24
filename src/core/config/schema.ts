import { z } from 'zod';
import { isStoreDomain } from '../validate.js';

export const CONFIG_VERSION = 1;

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'must be lowercase letters, numbers and dashes');
const text = z
  .string()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/, 'must not be empty or contain control characters');
const timestamp = z.iso.datetime();

/** Loose objects keep fields written by a newer ShopShift intact when an older one saves the file. */
export const accountSchema = z.looseObject({
  id,
  name: text.max(60),
  /** The alias Shopify CLI knows this session by. This is a label, never a credential. */
  alias: text.max(254).refine((value) => !value.startsWith('-'), 'must not start with a dash'),
  createdAt: timestamp,
});

export const workspaceSchema = z.looseObject({
  id,
  name: text.max(60),
  account: id,
  store: z.string().refine(isStoreDomain, 'must look like your-store.myshopify.com'),
  directory: text,
  themeId: z
    .string()
    .regex(/^[1-9]\d{0,19}$/, 'must be a numeric theme ID')
    .optional(),
  environment: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/, 'must be an environment name')
    .optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  createdAt: timestamp,
  lastUsedAt: timestamp.optional(),
});

export const configSchema = z.looseObject({
  version: z.literal(CONFIG_VERSION),
  activeWorkspace: id.optional(),
  defaultAccount: id.optional(),
  accounts: z.record(id, accountSchema),
  workspaces: z.record(id, workspaceSchema),
  preferences: z.looseObject({ editor: text.max(500).optional() }),
});

export type Account = z.infer<typeof accountSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Config = z.infer<typeof configSchema>;

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, accounts: {}, workspaces: {}, preferences: {} };
}

export interface IntegrityIssue {
  workspace?: string;
  message: string;
  fix: string;
}

/** Cross-references a structurally valid config can still get wrong, for example after a hand edit. */
export function findIntegrityIssues(config: Config): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  for (const [key, account] of Object.entries(config.accounts)) {
    if (key !== account.id) {
      issues.push({
        message: `Account "${key}" is stored under a different id ("${account.id}").`,
        fix: `Edit the config so the key and id match.`,
      });
    }
  }
  for (const [key, workspace] of Object.entries(config.workspaces)) {
    if (key !== workspace.id) {
      issues.push({
        workspace: key,
        message: `Workspace "${key}" is stored under a different id ("${workspace.id}").`,
        fix: 'Edit the config so the key and id match.',
      });
    }
    if (!Object.hasOwn(config.accounts, workspace.account)) {
      issues.push({
        workspace: key,
        message: `Workspace "${workspace.name}" uses an account that no longer exists ("${workspace.account}").`,
        fix: `shopshift edit ${key} --account <account>`,
      });
    }
  }
  if (
    config.activeWorkspace !== undefined &&
    !Object.hasOwn(config.workspaces, config.activeWorkspace)
  ) {
    issues.push({
      message: `The active workspace "${config.activeWorkspace}" no longer exists.`,
      fix: 'shopshift use <workspace>',
    });
  }
  if (
    config.defaultAccount !== undefined &&
    !Object.hasOwn(config.accounts, config.defaultAccount)
  ) {
    issues.push({
      message: `The default account "${config.defaultAccount}" no longer exists.`,
      fix: 'shopshift account use <account>',
    });
  }
  return issues;
}
