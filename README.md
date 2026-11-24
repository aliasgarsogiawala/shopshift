# ShopShift

**Multiple stores. One workspace.**

ShopShift is a local-first workspace manager for Shopify theme developers who work across several
stores and several Shopify accounts. It sits on top of the official
[Shopify CLI](https://shopify.dev/docs/api/shopify-cli) and does not replace it: every theme command
still runs through `shopify`, with its own prompts, colours, live output and exit codes. ShopShift
makes sure each command goes to the right store with the right account.

```
$ shopshift

  ShopShift
  Multiple stores. One workspace.

◆  Select a workspace
│  ● Client Store 01 (client-store-01 · Agency · production)
│  ○ Personal Store
│  ○ Brand Store
│  ○ + Add workspace
└

✓ Switched to Client Store 01
  Account    Agency  agency@example.com
  Store      client-store-01.myshopify.com
  Directory  ~/Projects/client-store-01
```

> ShopShift is an independent open-source project. It is not affiliated with or endorsed by Shopify.

## What it does

- **Accounts.** Give each Shopify account you sign in to a name ("Personal", "Agency") and reuse its
  session without opening the browser again. Built on Shopify CLI's own multi-account sessions
  (`--auth-alias`), never on copies of its tokens.
- **Workspaces.** A workspace ties together a project directory, a store, an account and, if you
  like, a default theme, a `shopify.theme.toml` environment and a development port. Add as many as
  you need.
- **Project detection.** Inside a workspace directory, or any directory below it, ShopShift knows
  which store and account you mean. Optional shell integration exports the same context for plain
  `shopify` commands.
- **Explicit context.** Every Shopify command gets `--store` and `--auth-alias` on its command line.
  Environment variables that could redirect it to another store, account or theme are removed.
- **Safe pushes.** Before a push you see the workspace, account, store, exact theme and whether it is
  live. Live themes need you to type the store name. Ambiguous targets are refused. ShopShift never
  publishes a theme.
- **Several development servers at once.** Each workspace gets its own port, conflicts are reported
  with a fix, and Shopify CLI startups are spaced out to avoid known races. See
  [Concurrency](#running-several-stores-at-once).
- **`doctor`.** Checks Node.js, Shopify CLI, your configuration, project directories, sessions, ports
  and conflicting environment variables, and says how to fix each problem.

## Requirements

- Node.js 22.12 or newer
- [Shopify CLI](https://shopify.dev/docs/api/shopify-cli) 4.9 or newer (tested with 4.9.4 and 5.0.2)
- macOS or Linux. Windows should work but has had less testing. Shell integration supports zsh and
  bash.

## Install

```sh
npm install -g @shopify/cli   # if you do not have it yet
npm install -g shopshift
shopshift init
```

`shopshift init` checks Shopify CLI, connects your first account and offers to create a workspace for
the current directory.

## Quick start

```sh
# Connect the accounts you use. Shopify CLI handles the sign-in in your browser.
shopshift account add Personal
shopshift account add Agency

# Create a workspace for each project.
cd ~/Projects/client-store-01
shopshift add                               # interactive
shopshift add "Client Store 01" --store client-store-01 --account agency   # or in one line

# Work as usual. ShopShift works out the store and account from the directory.
shopshift dev
shopshift pull --theme 123456789
shopshift push                              # shows exactly where it is going first
```

## Commands

| Command | What it does |
| --- | --- |
| `shopshift` | Choose a workspace from a menu, or add one |
| `shopshift init` | First-run setup |
| `shopshift doctor [--json]` | Check your setup and explain fixes |
| `shopshift account add [name] [--alias <alias>]` | Add an account profile |
| `shopshift account list [--check] [--json]` | List profiles, optionally checking each session |
| `shopshift account use [account] [--no-global]` | Make an account the default, here and in Shopify CLI |
| `shopshift account login [account]` | Renew an expired or missing session |
| `shopshift account remove [account] [--yes]` | Remove a profile (its Shopify session is untouched) |
| `shopshift add [name] [options]` | Add a workspace |
| `shopshift list [--json]` | List workspaces, with running servers |
| `shopshift use [workspace]` | Switch the active workspace |
| `shopshift edit [workspace] [options]` | Change a workspace |
| `shopshift remove [workspace] [--yes]` | Forget a workspace (files and store are untouched) |
| `shopshift status [--check] [--json]` | Current workspace, session and running servers |
| `shopshift current [--field <name>] [--json]` | Print the workspace for this directory |
| `shopshift dev` | `shopify theme dev` for the workspace |
| `shopshift pull` | `shopify theme pull` |
| `shopshift push` | `shopify theme push`, after confirming the target |
| `shopshift themes` | `shopify theme list` |
| `shopshift check` | `shopify theme check` (local, needs no account) |
| `shopshift info` | `shopify theme info` |
| `shopshift open admin\|store\|themes\|editor [--print]` | Open the admin, storefront, themes page or your editor |
| `shopshift config get\|set\|unset editor` | Choose the editor for `open editor` |
| `shopshift config path` | Print where the configuration lives |
| `shopshift shell init zsh\|bash [--no-cd]` | Print the shell integration |

Run any command with `--help` for its options.

### Theme commands

`dev`, `pull`, `push`, `themes`, `check` and `info` pass every other option to Shopify CLI
unchanged:

```sh
shopshift dev --live-reload full-page --open
shopshift pull --only 'sections/*.liquid' --nodelete
shopshift push --theme 123456789 --ignore 'config/settings_data.json'
```

They also take a few options of their own:

| Option | Meaning |
| --- | --- |
| `-w, --workspace <name>` | Use a workspace other than the one for this directory |
| `--dry-run` | Print the exact Shopify command (and, for `push`, the target) without running it |
| `--use-theme-token` | Authenticate with `SHOPIFY_CLI_THEME_TOKEN` or a TOML `password` instead of the account |
| `-y, --yes` | `push` only: skip the confirmation for a theme that is not live |
| `--confirm-live <id>` | `push` and `dev`: confirm a live theme without a prompt (with `--allow-live`) |
| `--allow-shared-theme` | `dev` only: allow a second server on the same store's development theme |

If you pass `--store` or `--auth-alias`, it must match the workspace. To work on another store, use
another workspace (`-w`). `--environment` picks a different `shopify.theme.toml` environment for that
one run.

### Which workspace?

1. `-w <workspace>`, if given.
2. The workspace whose directory contains the current directory. The deepest directory wins.
3. If several workspaces share that directory (one theme, several stores), the active one. When none
   of them is active, ShopShift asks, or fails with a list in scripts.
4. Outside every workspace directory: the active workspace, for `dev`, `themes`, `info`, `check`,
   `status` and `open`. `pull` and `push` overwrite files, so they refuse this fallback. Run them from
   the project directory or pass `-w`.

## Pushing safely

`shopshift push` resolves the target to a single theme ID before anything is uploaded:

```
  Push

  Workspace    Client Store 01
  Account      Agency  agency@example.com
  Store        client-store-01.myshopify.com
  Theme        LIVE  Dawn  #123456789, live
  Directory    ~/Projects/client-store-01

! Customers will see this change immediately.
◆  Type client-store-01 to push to the live theme
```

- The target comes from `--theme`/`--live`/`--development`/`--unpublished`, then the workspace's
  default theme, then the `shopify.theme.toml` environment, then a picker. In scripts, a missing
  target is an error.
- Theme names must match exactly one theme. Wildcards and duplicate names are refused. The command
  passed to Shopify CLI always uses the ID.
- Pushing to a live theme (or one whose role ShopShift does not recognise) needs the store name
  typed. `--yes` never applies to live themes. Unattended live pushes need both `--allow-live` and
  `--confirm-live <theme-id>`, and the ID must match.
- Contradictions are refused rather than resolved: `--live` together with `--theme`, a TOML
  environment that says `live = true` (Shopify CLI would silently let it win), a workspace theme
  that differs from the TOML, `SHOPIFY_FLAG_*` variables that point elsewhere, or a theme token in
  the environment while you push with an account.
- `--publish` is blocked, and so are `--force` (it would skip Shopify CLI's own confirmations) and
  `--password`. ShopShift never publishes a theme.
- If the store also has a `shopify store auth` session, Shopify CLI uses it for push and pull
  instead of the account. ShopShift warns you when that is the case.

## Running several stores at once

```sh
# terminal 1
cd ~/Projects/client-store-01 && shopshift dev   # http://127.0.0.1:9292
# terminal 2
cd ~/Projects/brand-store && shopshift dev        # http://127.0.0.1:9293
```

- Ports come from `--port`, then the workspace, then the TOML, then the first free port from 9292
  that no other workspace claims. A busy port gives a clear error. In a terminal, ShopShift offers
  the next free one.
- A second server for the same store would share Shopify CLI's single development theme for that
  store and overwrite the first. It is refused unless it targets its own theme (`--theme`) or you
  pass `--allow-shared-theme`.
- `shopshift status` and `shopshift list` show what is running.

**What is and isn't verified.** Selecting an account per command with `--auth-alias` is isolated:
two processes for two accounts each used their own token, and neither changed Shopify CLI's global
account. Shopify CLI keeps all sessions in one file, though. When two processes refresh tokens at the
same moment, one account's refreshed session can be lost. When a background refresh is rejected,
Shopify CLI 5 signs out every account. ShopShift prevents the overlaps it can: it starts one Shopify
command at a time and waits until a development server is listening before starting the next. It
cannot coordinate refreshes inside servers that are already running (every 30 minutes or so). If an
account is signed out, run `shopshift account login <account>`. The full method and results are in
[docs/CONCURRENCY.md](docs/CONCURRENCY.md). Running two real accounts against two real stores for
hours has not been tested.

## Shell integration

Shell integration is optional and never installed automatically. To enable it, add one line to your
own shell configuration:

```sh
# ~/.zshrc
eval "$(shopshift shell init zsh)"
# ~/.bashrc
eval "$(shopshift shell init bash)"
```

With it enabled:

- Entering a workspace directory exports `SHOPIFY_FLAG_STORE`, `SHOPIFY_FLAG_AUTH_ALIAS` and
  `SHOPSHIFT_WORKSPACE`, so plain `shopify theme …` commands use the same context. Leaving removes
  them. Variables you exported yourself are never changed or removed.
- `shopshift use <workspace>` changes into that workspace's directory. Pass `--no-cd` to
  `shell init` to turn this off.
- Set `SHOPSHIFT_QUIET=1` to hide the one-line notice on switching.

To turn it off, delete the line.

## Scripting

Every prompt has a flag that replaces it. Without a terminal, or with `SHOPSHIFT_NO_INPUT=1` or
`CI=true`, ShopShift never prompts and fails with the flag to use. Results go to stdout and messages
to stderr. Most read commands accept `--json`, and errors are then JSON too:

```sh
shopshift current --field store            # client-store-01.myshopify.com
shopshift list --json | jq '.workspaces[].id'
shopshift push --theme 123 --yes --json    # {"error":{"code":"…","message":"…","hint":"…"}} on failure
```

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | General failure (also: `doctor` found a problem) |
| 2 | Usage or validation error, or a prompt was needed without a terminal |
| 3 | No workspace, or more than one could apply |
| 4 | Shopify session missing or expired |
| 5 | Refused for safety: conflicting context, ambiguous target or unconfirmed push |
| 6 | Port in use |
| 70 | Internal error in ShopShift |
| 127 | Shopify CLI not found |
| 130 | Cancelled |

Theme commands otherwise exit with Shopify CLI's own exit code. If Shopify CLI is killed by a signal,
ShopShift ends with the same signal.

## Configuration

One JSON file holds names, aliases, stores, directories and preferences. It contains no tokens or
passwords.

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Application Support/shopshift/config.json` |
| Linux | `$XDG_CONFIG_HOME/shopshift/config.json` (default `~/.config/shopshift`) |
| Windows | `%APPDATA%\shopshift\config.json` |

Writes are atomic and locked across processes, and the previous version is kept as
`config.json.bak`. Running servers and locks live in a separate state directory (`~/Library/Caches`,
`$XDG_STATE_HOME` or `%LOCALAPPDATA%`).

| Variable | Effect |
| --- | --- |
| `SHOPSHIFT_CONFIG_DIR` | Use another configuration directory (absolute path) |
| `SHOPSHIFT_SHOPIFY_BIN` | Use a specific Shopify CLI executable (absolute path) |
| `SHOPSHIFT_EDITOR` | Editor for `open editor`, after `config set editor` and before `$VISUAL`/`$EDITOR` |
| `SHOPSHIFT_NO_INPUT` | Never prompt |
| `SHOPSHIFT_QUIET` | Silence the shell integration's notices |
| `SHOPSHIFT_DEBUG` | Print stack traces for internal errors |
| `NO_COLOR`, `FORCE_COLOR` | Colour output |

## Limitations

- Shopify CLI names sessions after the account's email address, and offers no way to list them.
  ShopShift reads the alias back after you sign in, or you can pass `--alias`.
- When an expired session is renewed, Shopify CLI keeps the old alias even if a different person
  signs in. ShopShift reminds you which account to approve in the browser.
- `shopify auth logout` signs out every account and deletes development themes. ShopShift never
  calls it. `account remove` only forgets the profile.
- Theme commands only. App development (`shopify app …`) is out of scope for now.

## Uninstall

```sh
npm uninstall -g shopshift
```

Then delete the configuration directory (`shopshift config path` shows where it is) and remove the
shell integration line, if you added it. Your Shopify CLI sessions are not affected.

## More

- [Architecture](docs/ARCHITECTURE.md)
- [Concurrency research](docs/CONCURRENCY.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
