# Security

## Reporting a vulnerability

Please report vulnerabilities privately rather than in a public issue: use GitHub's
"Report a vulnerability" button on the repository's Security tab. Include the ShopShift and Shopify
CLI versions, your operating system, and steps to reproduce. You should get a reply within a week.

Never include real tokens, passwords or store data in a report.

## Supported versions

Only the latest release receives security fixes.

## How ShopShift handles credentials

- **No credentials are stored.** The configuration file holds display names, Shopify CLI session
  aliases (the account's email address), store domains, directories and preferences. It never holds
  tokens or passwords.
- **Authentication stays with Shopify.** Sign-in goes through `shopify auth login` in your browser.
  ShopShift never asks for a Shopify password, and never reads, copies, edits or deletes Shopify
  CLI's session files. It selects a session by passing `--auth-alias` to Shopify CLI.
- **Credentials are never printed.** `doctor`, `status` and error messages name credential variables
  such as `SHOPIFY_CLI_THEME_TOKEN` but never show their values. Error output from Shopify CLI is
  redacted of anything token-shaped before ShopShift shows it.
- **Credentials are not passed on by accident.** Child processes do not receive
  `SHOPIFY_CLI_THEME_TOKEN` or other credential variables unless you ask for theme-token
  authentication with `--use-theme-token`. `--password` on the command line is refused because other
  local users could read it from the process list.
- **No shell.** Every process is started with an argument array, never through a shell, so values
  such as theme names or paths cannot inject commands. The shell integration quotes every value it
  exports, and only ever sets or unsets its own three variables.
- **Validated input.** Store domains must be `*.myshopify.com` hostnames. Names, aliases, theme IDs,
  ports, environment names and directories are validated before they are saved or passed on, and the
  configuration file is validated whenever it is read.
- **No network access of its own.** ShopShift talks only to Shopify CLI, which talks to Shopify. It
  has no telemetry, no analytics and no update checks.
- **Shopify's own safeguards stay in place.** ShopShift adds confirmations. It never removes Shopify
  CLI's: it does not pass `--force`, `--allow-live` or `--publish` on your behalf.
- **Private files.** The configuration and state directories are created with mode `0700`, and locks
  with `0600`.

## Known limitations

See [docs/CONCURRENCY.md](docs/CONCURRENCY.md) for how Shopify CLI's shared session file behaves
when several processes run at once.
