# Changelog

All notable changes to ShopShift are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - Unreleased

First release.

### Added

- Account profiles on top of Shopify CLI's multi-account sessions: `account add`, `list`, `use`,
  `login` and `remove`.
- Workspaces linking a directory, store, account, default theme, TOML environment and development
  port: `add`, `list`, `use`, `edit`, `remove`, `status`, `current`, plus an interactive menu and an
  `init` wizard.
- Project detection from the current directory, including nested directories and several stores
  sharing one theme directory.
- Theme commands that pass explicit `--store` and `--auth-alias` to Shopify CLI and strip
  conflicting environment variables: `dev`, `pull`, `push`, `themes`, `check`, `info`.
- Push safeguards: one exact target theme, a summary before every push, typed confirmation for live
  themes, refusal of ambiguous or contradictory targets, `--publish` blocked.
- Concurrent development servers with per-workspace ports, port conflict detection and a launch gate
  that spaces out Shopify CLI startups.
- `doctor` with JSON output.
- Optional zsh and bash integration that exports the workspace context on `cd`.
- `open admin|store|themes|editor` and `config` for the editor setting.
- A core API (`import … from 'shopshift'`) with no terminal dependencies.
