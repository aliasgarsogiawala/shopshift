# Contributing

Thanks for helping improve ShopShift.

## Setup

```sh
git clone <your fork>
cd shopshift
npm install
npm run build
node dist/bin.js --help
```

Node.js 22.12 or newer is required. You do not need a Shopify account or store to develop or test
ShopShift: the test suite uses a mock Shopify CLI.

## Checks

```sh
npm run lint        # Biome
npm run typecheck
npm test            # builds, then runs unit and integration tests
npm run test:pack   # packs the tarball, installs it globally into a temp prefix and runs it
npm run verify      # all of the above
```

`npm run format` fixes formatting.

## Tests

- `test/unit` tests the core modules directly.
- `test/integration` runs the built CLI (`dist/bin.js`) as a child process against
  `test/helpers/mock-shopify.mjs`. The mock records every invocation (arguments, working directory,
  `SHOPIFY_*` variables, whether it had a terminal) and answers in the JSON shapes of Shopify CLI 4.x
  and 5.x. It never opens a network connection.
- `Sandbox` (`test/helpers/sandbox.ts`) gives each test its own home directory, configuration and
  mock state.
- Shell integration tests run real `zsh` and `bash` when they are installed.

**Never point tests or manual experiments at a real store, and never run them with your real
Shopify CLI sessions.** If you need the real Shopify CLI, use a throwaway `HOME` and set
`SHOPIFY_CLI_NO_ANALYTICS=1`.

## Guidelines

- Keep dependencies to a minimum. Each one needs a clear reason.
- `src/core` must not import from `src/cli` or `src/ui`, or write to the terminal. It is the API a
  future desktop app would use.
- Every prompt needs a non-interactive alternative, named in the `alternative` passed to `Prompts`.
- Results go to stdout and everything else to stderr.
- Use only documented Shopify CLI commands and flags, and check new ones against both the oldest
  supported version (4.9) and the newest.
- Safety checks fail closed: when ShopShift cannot tell what a push would do, it refuses.
- Add a changelog entry under "Unreleased".

## Commits and pull requests

Keep pull requests focused, and describe what changed and how you tested it. CI must pass.
