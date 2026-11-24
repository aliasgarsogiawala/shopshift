import type { Shell } from './hook.js';

export interface ShellScriptOptions {
  /** Let `shopshift use` change into the workspace directory. */
  cd: boolean;
}

/**
 * The integration is printed, never installed. Developers opt in by adding one line to their own
 * shell configuration, and opt out by removing it.
 */
export function shellScript(shell: Shell, options: ShellScriptOptions): string {
  return shell === 'zsh' ? zsh(options) : bash(options);
}

export function installLine(shell: Shell): string {
  return `eval "$(shopshift shell init ${shell})"`;
}

export function rcFile(shell: Shell): string {
  return shell === 'zsh' ? '~/.zshrc' : '~/.bashrc';
}

const apply = (shell: Shell) => `
_shopshift_apply() {
  local __shopshift_out
  __shopshift_out="$(command shopshift shell hook ${shell})" || return 0
  if [ -n "$__shopshift_out" ]; then eval "$__shopshift_out"; fi
  return 0
}
`;

/**
 * A child process cannot change its parent's directory or variables. This wrapper re-evaluates the
 * context after commands that change it and, if enabled, follows \`use\` into the project.
 */
const wrapper = (options: ShellScriptOptions) => `
shopshift() {
  case "\${1-}" in
    ""|use|add|edit|remove|rm|init) ;;
    *) command shopshift "$@"; return $? ;;
  esac
  local __shopshift_status=0${
    options.cd
      ? `
  local __shopshift_file __shopshift_dir
  __shopshift_file="$(mktemp "\${TMPDIR:-/tmp}/shopshift.XXXXXX")" || { command shopshift "$@"; return $?; }
  SHOPSHIFT_CD_FILE="$__shopshift_file" command shopshift "$@" || __shopshift_status=$?
  __shopshift_dir="$(cat "$__shopshift_file" 2>/dev/null)"
  command rm -f "$__shopshift_file"
  if [ "$__shopshift_status" -eq 0 ] && [ -n "$__shopshift_dir" ] && [ -d "$__shopshift_dir" ]; then
    builtin cd -- "$__shopshift_dir" || __shopshift_status=$?
  fi`
      : `
  command shopshift "$@" || __shopshift_status=$?`
  }
  _shopshift_apply
  return $__shopshift_status
}
`;

function zsh(options: ShellScriptOptions): string {
  return `# ShopShift shell integration for zsh
# Add this to ${rcFile('zsh')}:  ${installLine('zsh')}
${apply('zsh')}${wrapper(options)}
autoload -Uz add-zsh-hook
add-zsh-hook chpwd _shopshift_apply
_shopshift_apply
`;
}

function bash(options: ShellScriptOptions): string {
  return `# ShopShift shell integration for bash
# Add this to ${rcFile('bash')}:  ${installLine('bash')}
${apply('bash')}${wrapper(options)}
_shopshift_prompt() {
  local __shopshift_status=$?
  if [ "\${_SHOPSHIFT_PWD-}" != "$PWD" ]; then
    _SHOPSHIFT_PWD="$PWD"
    _shopshift_apply
  fi
  return $__shopshift_status
}
case ";\${PROMPT_COMMAND-};" in
  *";_shopshift_prompt;"*) ;;
  *) PROMPT_COMMAND="_shopshift_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
`;
}
