import { ShopShiftError } from './errors.js';

const STORE_HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const STORE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we reject.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

function invalid(message: string, hint?: string): never {
  throw new ShopShiftError('VALIDATION', message, { hint });
}

/**
 * Normalises any common way of naming a store to `handle.myshopify.com`.
 *
 * Custom domains are rejected on purpose: Shopify CLI would silently turn `brand.com` into
 * `brand.com.myshopify.com`, and only the permanent domain identifies a store unambiguously.
 */
export function normalizeStore(input: string): string {
  const raw = input.trim().toLowerCase();
  if (raw === '') invalid('A store is required.', 'Use the form your-store.myshopify.com.');
  const hint = 'Use the permanent domain, for example your-store.myshopify.com.';

  if (STORE_HANDLE.test(raw)) return `${raw}.myshopify.com`;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return invalid(`"${input}" is not a valid store.`, hint);
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    return invalid(`"${input}" is not a valid store.`, hint);
  }
  if (url.hostname === 'admin.shopify.com') {
    const handle = /^\/store\/([^/]+)(?:\/.*)?$/.exec(url.pathname)?.[1];
    if (handle !== undefined && STORE_HANDLE.test(handle)) return `${handle}.myshopify.com`;
  }
  if (STORE_DOMAIN.test(url.hostname) && /^\/(?:admin\/?.*)?$/.test(url.pathname)) {
    return url.hostname;
  }
  return invalid(`"${input}" is not a myshopify.com store.`, hint);
}

export function isStoreDomain(value: string): boolean {
  return STORE_DOMAIN.test(value);
}

export function storeHandle(store: string): string {
  return store.replace(/\.myshopify\.com$/, '');
}

export function validateName(input: string, label = 'Name'): string {
  const name = input.trim();
  if (name === '') invalid(`${label} cannot be empty.`);
  if (name.length > 60) invalid(`${label} must be 60 characters or fewer.`);
  if (CONTROL_CHARACTERS.test(name)) invalid(`${label} contains control characters.`);
  return name;
}

/** Turns a display name into the identifier used on the command line. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  if (slug === '') invalid(`"${name}" needs at least one letter or number.`);
  return slug;
}

/**
 * Shopify uses the account email as the alias, or a free-text label when the email is unavailable.
 * A leading dash is rejected because the value is passed to another CLI as a flag argument.
 */
export function validateAlias(input: string): string {
  const alias = input.trim();
  if (alias === '') invalid('An authentication alias is required.');
  if (alias.length > 254) invalid('The authentication alias is too long.');
  if (CONTROL_CHARACTERS.test(alias)) invalid('The authentication alias has control characters.');
  if (alias.startsWith('-')) invalid('The authentication alias cannot start with a dash.');
  return alias;
}

export function validateThemeId(input: string): string {
  const id = input.trim().replace(/^#/, '');
  if (!/^[1-9]\d{0,19}$/.test(id)) {
    invalid(
      `"${input}" is not a theme ID.`,
      'Theme IDs are numeric. List them with: shopshift themes',
    );
  }
  return id;
}

export function validatePort(input: string | number): number {
  const port = typeof input === 'number' ? input : Number(input.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid(`"${input}" is not a valid port.`, 'Use a number between 1 and 65535.');
  }
  return port;
}

export function validateEnvironmentName(input: string): string {
  const name = input.trim();
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    invalid(
      `"${input}" is not a valid environment name.`,
      'Use the name after "environments." in shopify.theme.toml.',
    );
  }
  return name;
}
