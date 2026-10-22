# pi-rex-subagents launcher — runs INSIDE `zsh -l -i -c`, i.e. after the full
# startup sequence a brand-new Rex pane gets:
#   /etc/zshenv → ~/.zshenv → /etc/zprofile → ~/.zprofile → /etc/zshrc → ~/.zshrc → ~/.zlogin
#
# Spawned by the extension as:
#   rex split --shell=none --keep-open -c CWD -- /bin/zsh -l -i -c 'source "$0" "$@"' \
#       <this file> --cwd CWD [--export NAME=VALUE]... [--no-direnv] -- PROGRAM [ARGS...]
#
# Why this shape:
# - `--shell=none` makes zsh the block's child process directly. Nothing is typed into a
#   prompt, so there is no launch race.
# - The Rex server's own env is a bare launchd env (PATH=/usr/bin:/bin:..., no nix-darwin /
#   home-manager state), so `-l -i` rebuilds the shell context from scratch exactly like a
#   new pane does, rather than copying the orchestrator's env.
# - Rex's default (non-`none`) shell mode runs a *login* shell but not an *interactive* one,
#   so ~/.zshrc (home-manager initContent: ~/.local/bin PATH, tokens, ...) would be skipped.
# - The direnv hook is a precmd function and `-c` never draws a prompt, so we run the
#   equivalent `direnv export zsh` ourselves, once, in the target cwd.
# - Everything arrives as argv. Rex passes COMMAND arguments to execve unchanged, so no
#   shell quoting is generated anywhere; the extension builds a string array and that is it.
# - The program is `exec`ed: pi becomes the block's process, Rex reports pi's own exit
#   code via `rex wait` / `child_exited`, and nothing needs to stay alive to write sidecars.
#   Ctrl+Z is handled by disabling pi's `app.suspend` keybinding, not here.

_pi_rex_subagent_main() {
  emulate -L zsh

  local cwd="" direnv=1
  # NB: `argv` is zsh's alias for $@ — never use it as a local name.
  local -a exports program

  while (( $# )); do
    case $1 in
      --cwd) cwd=$2; shift 2 ;;
      --export) exports+=("$2"); shift 2 ;;
      --no-direnv) direnv=0; shift ;;
      --) shift; break ;;
      *) print -u2 "pi-rex-subagents launcher: unknown argument: $1"; return 64 ;;
    esac
  done
  program=("$@")

  if (( ${#program} == 0 )); then
    print -u2 "pi-rex-subagents launcher: no program given after --"
    return 64
  fi
  if [[ -z $cwd ]]; then
    print -u2 "pi-rex-subagents launcher: --cwd is required"
    return 64
  fi

  cd -- "$cwd" || return 66

  # Same thing the precmd direnv hook would do on this shell's first prompt. If the .envrc
  # isn't allowed, direnv prints its usual error and exports nothing; we carry on.
  if (( direnv )) && (( ${+commands[direnv]} )); then
    eval "$(direnv export zsh)"
  fi

  # Extension-supplied vars are applied after direnv so they always win.
  local kv
  for kv in "${exports[@]}"; do
    export "$kv"
  done

  exec "${program[@]}"
}

_pi_rex_subagent_main "$@"
