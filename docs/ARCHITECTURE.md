# Architecture

ShopShift is a thin, careful layer between a developer and Shopify CLI. It owns three things:
remembering which store and account belong to which project, building the exact Shopify command for
that context, and refusing commands whose effect it cannot pin down. Everything that talks to Shopify
is done by Shopify CLI.

```
            ┌──────────────────────────────── src/cli ───────────────────────────────┐
 argv ────▶ │ program.ts (commander) ─▶ commands/* ─▶ select.ts / auth.ts            │
            └───────┬──────────────────────────────────────────────────┬────────────┘
                    │ uses                                             │ renders with
            ┌───────▼──────────── src/core (no terminal I/O) ────┐  ┌──▼── src/ui ───────┐
            │ config/  accounts  workspaces  detection           │  │ output  prompts    │
            │ safety/  (guard, target, push)                     │  │ style              │
            │ shopify/ (locate, version, flags, args, client)    │  └────────────────────┘
            │ environment  theme-config  process  ports          │
            │ sessions  launch-gate  doctor  opener  shell/      │
            │ fs/ (atomic writes, cross-process locks)           │
            └───────────────────────┬────────────────────────────┘
                                    │ spawn(file, args[]) — never a shell
                              ┌─────▼──────┐
                              │ shopify    │ ──▶ Shopify
                              └────────────┘
```

## Layers

- **`src/core`** holds all behaviour. It never writes to the terminal or prompts. Errors are
  `ShopShiftError`s with a stable `code`, a message, optional details and a hint. `src/index.ts`
  exports it as the package's library entry, so a desktop app (Tauri or otherwise) can reuse the
  same configuration, detection, safety checks and Shopify adapter.
- **`src/ui`** handles presentation: colours (respecting `NO_COLOR`/`FORCE_COLOR`), a spinner, and
  Clack prompts drawn on stderr. Each prompt takes the flag that replaces it and fails with that flag
  when there is no terminal.
- **`src/cli`** wires commander to the core. `app.ts` builds the dependencies once per run, and
  `bin.ts` is the executable. The shell hook takes a fast path in `bin.ts` that loads only
  `core/shell/hook.ts` and `core/paths.ts`, because it runs on every directory change (about 20 ms).

## Data

`config.json` (see `core/config/schema.ts`) holds accounts, workspaces, the active workspace, the
default account and preferences. Schemas use loose objects, so fields added by a newer version
survive a write by an older one. A config written by a newer major format is refused instead of
being overwritten.

Every change goes through `ConfigStore.update(mutate)`:

1. take an exclusive lock file (`open(…, 'wx')`, holder PID and token inside, stale detection by
   dead PID or age, with a second lock guarding the takeover itself);
2. re-read and validate the file inside the lock;
3. apply the change, validate the result, copy the old file to `config.json.bak`;
4. write a temporary file, fsync it, and rename it over the original.

So concurrent ShopShift processes never lose each other's changes, and a crash never leaves a
half-written file.

Runtime state lives in a separate state directory: `sessions/<pid>.json` for running development
servers (removed on exit, and ignored once the PID is gone), `launch.lock`, and a cache of the Shopify
CLI version keyed by the executable's real path, inode, size and change time.

## Running a theme command

Take `shopshift push --theme Staging` as an example.

1. **Parse.** Commander takes ShopShift's own options. Everything else goes to
   `shopify/flags.ts`, which knows each theme command's flags (long, short, clustered, `=value`,
   multi-value) as defined by Shopify CLI, so it can tell a flag's value from a positional argument.
2. **Select the workspace** (`detection.ts`): `-w`, else the deepest workspace directory containing
   the current directory, else the active workspace. Writes (`push`, `pull`) refuse the fallback.
3. **Guard the context** (`safety/guard.ts`): `--store` and `--auth-alias` must match the workspace.
   `--publish`, `--force`, `--password`, unknown push flags and stray positionals are refused.
   `SHOPIFY_FLAG_*` and credential variables that disagree with the workspace block a push and are
   stripped (with a warning) elsewhere. `shopify.theme.toml` is read the way Shopify CLI reads it
   (walking up, applying `[environments.default]` implicitly) so its settings can be checked too.
4. **Resolve the target** (`safety/target.ts`, `safety/push.ts`): flags, then the workspace theme,
   then the TOML, then a picker. Contradictions are errors. The theme list is fetched through
   Shopify CLI (`theme list --json`, both the 4.x and 5.x shapes), and the target is reduced to one
   theme ID with a role. Live and unknown roles require typed confirmation.
5. **Build the command** (`shopify/args.ts`): `theme push --store <store> --auth-alias <alias>
   [--environment <env>] --theme <id> <remaining flags>`. Context flags that were forwarded are
   removed first, so nothing appears twice.
6. **Build the environment** (`environment.ts`): the parent environment minus every
   `SHOPIFY_FLAG_*` not on a short presentation allowlist, and minus credentials unless
   `--use-theme-token` was given.
7. **Run** (`process.ts`): `spawn(file, args, { stdio: 'inherit', shell: false })` in the workspace
   directory, so Shopify CLI keeps the terminal, its prompts and its colours. SIGINT, SIGTERM and
   SIGHUP are forwarded. The exit code is passed on, and a death by signal is re-raised.
8. **Recover.** If the command failed, ShopShift asks Shopify CLI whether the alias still has a
   session. If not, it offers to sign in and retry (interactive), or exits 4 with the command to
   run.

Captured calls (`theme list --json`, `theme info --json`, `store auth list --json`, the alias probe)
go through `capture()`, which has a timeout and an output cap. Their errors are redacted before
display.

### Checking a session without the network

`shopify theme check --version --auth-alias <alias>` resolves the alias the same way every theme
command does, but needs no store and makes no request. It exits 1 with "No authenticated account
found for alias" when the session is missing. `client.aliasStatus()` uses this, and so do `doctor`,
`account add --alias` and the recovery step above.

## Concurrency

`launch-gate.ts` is a cross-process lock held while a Shopify command starts: for `dev`, until its
port answers twice (or 60 s), and for other commands, until they exit (or 15 s). If the gate cannot
be taken within 25 s, the command runs anyway with a warning rather than hanging. The reasons, and
the limits, are in [CONCURRENCY.md](CONCURRENCY.md).

`dev` also checks the session registry. It refuses to start a second server on the same store's
development theme. When two servers start at the same instant, the earlier registration keeps the
theme.

## Shell integration

`core/shell/scripts.ts` prints a script and never writes to disk. The script defines:

- `_shopshift_apply`, which evaluates the output of `shopshift shell hook <shell>`;
- a zsh `chpwd` hook, or for bash a `PROMPT_COMMAND` entry that runs only when `$PWD` changed and
  preserves `$?`;
- a `shopshift` function that re-applies the context after `use`, `add`, `edit`, `remove` and
  `init`, and changes directory after `use` through a temporary file named in `SHOPSHIFT_CD_FILE`.

`core/shell/hook.ts` reads the config without validation libraries, picks the workspace like
`detection.ts`, and prints `export`/`unset` lines quoted with single quotes. It tracks what it
exported in `SHOPSHIFT_MANAGED`, never touches a variable the user set, and only ever manages
`SHOPSHIFT_WORKSPACE`, `SHOPIFY_FLAG_STORE` and `SHOPIFY_FLAG_AUTH_ALIAS`. On any error it prints
nothing.

## Dependencies

| Package | Why |
| --- | --- |
| `commander` | Argument parsing and help |
| `@clack/prompts` | Interactive prompts |
| `zod` | Validating the configuration file |
| `smol-toml` | Reading `shopify.theme.toml` exactly |

No HTTP client, no telemetry, no bundler: the build is plain `tsc`.
