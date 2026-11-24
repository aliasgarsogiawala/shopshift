# Concurrency research

The brief for ShopShift included: *"Test whether Shopify's native authentication implementation
supports concurrent sessions reliably. Do not claim isolation that has not been verified."* This
document records what was tested, how, and what ShopShift does about it.

## Background

Shopify CLI (since 3.85) can hold sessions for several accounts. Each is stored under an alias (the
account's email), and theme commands accept `--auth-alias <alias>` (since 4.6) or
`SHOPIFY_FLAG_AUTH_ALIAS` to choose one for a single command. All sessions live in **one** file,
`shopify-cli-kit-nodejs/config.json` in the user's preferences directory, along with the globally
"current" session. The development theme ID for each store is kept in another shared file.

## Method

The real Shopify CLI 4.9.4 and 5.0.2 were run unmodified, as separate processes, against a local mock
of Shopify's identity and Admin endpoints. The mock was loaded with Node's `--require` and redirected
every HTTPS request to `127.0.0.1`. Each run used a throwaway `HOME`, seeded with two fake accounts
(`a@example.test` and `b@example.test`, each with a fake store) and fake tokens. No real account,
session or store was involved. The mock logged which token each request carried and could delay or
reject token refreshes.

## Results

| # | Experiment | 4.9.4 | 5.0.2 |
| --- | --- | --- | --- |
| A | Two processes at once, `theme list --store store-a --auth-alias a@…` and `--store store-b --auth-alias b@…`, valid tokens | Each sent only its own account's token. The global current account was unchanged. | Same |
| B | As A, but both access tokens expired, so both refresh concurrently (3 runs) | One account's refreshed session lost in 3 of 3 runs | 3 of 3 |
| B2 | Same two refreshes, one after the other | Both kept | Both kept |
| C | Account A's background refresh rejected (`invalid_grant`) by a non-interactive call, as a running `theme dev` does every 30 minutes; account B valid | not run | **All** accounts' sessions removed, including B's |
| D | `theme info --development` for store A starts while `theme list` for store B runs | Lookup for store A used store B's development theme ID and erased B's mapping | Same |

**What this means:**

- **Selection is isolated (A).** `--auth-alias` per process is reliable for choosing which account a
  command uses, and does not disturb other processes or the global account. ShopShift relies on it.
- **Storage is not (B, C).** Shopify CLI rewrites the whole session file without a lock, so two
  processes refreshing at the same time overwrite each other's work. The losing account then needs
  to sign in again. It is not mixed up with the other account. And a rejected refresh in 5.x clears
  every account, not just the one that failed.
- **Startup state is shared (D).** Shopify CLI keeps "the current store" in shared state while
  starting. Overlapping starts can resolve one store's development theme from another's.

## What ShopShift does

- **Explicit context.** Every command gets `--store` and `--auth-alias`. Nothing depends on Shopify
  CLI's global "current" account or store.
- **A launch gate.** A cross-process lock lets one Shopify command start at a time. `dev` holds it
  until its server answers on its port (at most 60 s), and other commands until they exit (at most
  15 s). This removes the overlaps in B and D for everything ShopShift starts. It also staggers the
  30-minute refresh timers of servers started through ShopShift, which makes simultaneous refreshes
  unlikely. If the gate is busy for more than 25 s, the command goes ahead with a warning.
- **Sequential checks.** ShopShift's own background calls (theme list, development theme lookup,
  session probes in `doctor`) run one at a time.
- **One server per development theme.** A second `dev` for the same store is refused unless it
  targets another theme, because Shopify CLI keeps a single development theme per store and machine.
- **Recovery.** After a failed command, ShopShift checks whether the account's session still exists
  and offers to sign in again (`shopshift account login <account>`).

## What ShopShift cannot do

- It cannot coordinate token refreshes that happen *inside* development servers that are already
  running, or inside `shopify` commands started outside ShopShift. Those can still collide (B) or,
  with Shopify CLI 5, sign out every account after a rejected refresh (C).
- It does not, and will not, edit Shopify CLI's session file to repair or merge sessions.

## Not verified

- Two real accounts against two real stores, running for hours.
- Whether Shopify's identity service rotates refresh tokens or invalidates the previous one, which
  decides how often B happens in practice.
- Windows file-replacement behaviour of the session file.

If you hit a lost session, run `shopshift account login <account>`, and please report it, with
versions and what was running, so this document can be updated.
