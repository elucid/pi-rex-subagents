# pi-rex-subagents

Subagent orchestration for [pi](https://github.com/earendil-works/pi) inside the
[Rex](https://www.superlogical.com/rex) multiplexer.

Status: **handoff proven end-to-end; orchestrator tools not yet ported.**

## How it works

Three native channels, no sidecars, no plugin, no event stream:

```
orchestrator ──rex split --shell=none -- argv──▶ launcher (zsh -l -i) ──exec──▶ child pi
orchestrator ◀──rex wait --json (exit code)──────────────────────────────── child pi exits
orchestrator ◀──reads the child's session .jsonl (handoff entry, last message)
```

- `launch/subagent-launch.zsh` rebuilds a fresh pane's shell environment (login +
  interactive zsh, then `direnv export`), applies the extension's env, and `exec`s pi.
  Everything arrives as argv; nothing is shell-quoted anywhere.
- `subagent-done.ts` (loaded into the child with `-e`) provides `subagent_done` /
  `caller_ping` and auto-exit. On the way out it appends one `subagent-handoff`
  custom entry to the child's own session file via `pi.appendEntry()`.
- `src/watcher.ts` awaits `rex wait` for the block, reads the transcript, and
  classifies: completed / ping / user-exit / failed / killed. Blocks are created with
  `--keep-open`: a clean exit is closed by the parent immediately; a non-zero exit is
  captured (`rex capture`) and left open for the user to read.

## Requirements

- pi inside a Rex terminal (`REX_SESSION` / `REX_BLOCK` set).
- `"app.suspend": []` in `~/.pi/agent/keybindings.json` — the child is the block's
  only process, so a SIGSTOP'd pi has no shell to `fg` it from.

## Try the handoff

```sh
node test/e2e-child.ts done ~/some/devenv/repo    # also: auto, ping, stay, badmodel
```
