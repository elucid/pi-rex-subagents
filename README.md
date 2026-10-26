# pi-rex-subagents

Subagent orchestration for [pi](https://github.com/earendil-works/pi) inside the
[Rex](https://www.superlogical.com/rex) multiplexer. An orchestrator session spawns
child pi sessions into Rex panes beside it, keeps working, and is woken with each
child's report when it finishes.

Descendant of [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
(HazAT) by way of a herdr-native fork. The orchestration model and agent-definition
format are theirs; the implementation here is written against Rex's own primitives
and is about a third the size, because Rex provides what the earlier versions had to
build: argv-exact pane launch, a wait-for-exit with the exit code, and screen capture.

## How it works

Three native channels. No sidecar files, no mux plugin, no event stream, no polling.

```
orchestrator ──rex split --shell=none -- argv──▶ launcher (zsh -l -i) ──exec──▶ child pi
orchestrator ◀──rex wait --json (exit code)──────────────────────────────── child pi exits
orchestrator ◀──reads the child's session .jsonl (handoff entry, last message)
```

- **Launch.** `launch/subagent-launch.zsh` runs under `zsh -l -i`, so the child gets
  exactly the environment a fresh Rex pane gets — including `~/.zshrc`, and the
  project's `.envrc` via `direnv export` (devenv, nix, varlock all just work). It then
  `exec`s pi, so pi is the block's process and Rex reports pi's own exit code.
  Everything arrives as argv; nothing is shell-quoted anywhere.
- **Handoff.** `subagent-done.ts` is loaded into every child. It provides
  `subagent_done(summary)` and `caller_ping(message)`, and on the way out appends one
  `subagent-handoff` custom entry to the child's own session file via
  `pi.appendEntry()` (summary or message, plus context usage). The entry is not model
  context, and it stays in the transcript as a record of what was handed off.
- **Lifecycle.** `src/watcher.ts` awaits `rex wait` for the child's block, reads the
  transcript, and classifies: `completed`, `ping`, `user-exit`, `failed`, `killed`.
  Blocks are created with `--keep-open`: a clean exit is closed by the orchestrator
  immediately; a non-zero exit is captured (`rex capture`) into the steer message and
  the pane is **left open** for you to read.
- **Wake-up.** The outcome becomes a `subagent_result` / `subagent_ping` steer message
  (`pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`) carrying the
  summary, the child's session path (resumable), elapsed time, and context usage.
- **Persistence.** Each spawn is recorded in the orchestrator's session; on
  `session_start` unsettled children are re-attached, so `/reload` and
  `pi --session …` never orphan a running child or lose a result that landed while
  nobody was watching.

## Requirements

- pi ≥ 1.4 running **inside a Rex terminal** (`REX_SESSION` / `REX_BLOCK` set).
  Outside Rex the extension registers only the message renderers.
- `zsh` as the login shell (the launcher is zsh).
- `"app.suspend": []` in `~/.pi/agent/keybindings.json`. The child is its block's only
  process, so a SIGSTOP'd pi has no shell to `fg` it from.

## Setup

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["/path/to/pi-rex-subagents"] }
```

Start pi in a Rex pane. The tools and commands below appear automatically.

## Tools

| Tool | What it does |
|---|---|
| `subagent` | Spawn a child in a pane beside you. Returns immediately; the result arrives later as a steer. |
| `subagent_resume` | Resume a child's session in a new pane, optionally with a follow-up message. |
| `subagent_interrupt` | Send Escape to a running child's current turn. |
| `subagents_list` | List agent definitions and currently running children. |

`subagent` parameters: `name`, `task`, and optional `agent`, `systemPrompt`, `model`
(`provider/id`), `thinking`, `skills`, `tools`, `cwd`, `fork`, `autoExit`. Every
optional parameter overrides the agent definition for that one call.

**`autoExit`** decides whether the child closes its own pane when its task is done.
It resolves as *parameter → agent definition → `true`*. Ask the orchestrator to
"leave it open" / "I want to talk to it" and it passes `autoExit: false`; the child
then stays until it calls `subagent_done` or you quit it (`/quit`, Ctrl+D). Either
way you get a steer: the summary, or the honest "closed by user, no subagent_done"
with its last message.

Commands: `/subagent <agent> [task]` spawns a named agent; `/iterate [task]` forks
the current conversation into an open pane.

## Agent definitions

Optional. `~/.pi/agent/agents/*.md` (global) and `.pi/agents/*.md` (project, wins)
with frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance
model: anthropic/claude-sonnet-4-5
thinking: low
tools: read, bash
spawning: false        # deny the subagent* tools to this child
auto-exit: true
system-prompt: replace # or append; omit to put the body in the first message instead
session-mode: standalone   # or lineage-only / fork
---
Role instructions…
```

Also honoured: `skills` (named in the task text as skills to read first; not injected),
`deny-tools`, `cwd`, `disable-model-invocation`. Without
any definitions, bare `subagent({name, task, …})` still works with pi's defaults.
Definitions are read on each call, so edits apply to the next spawn.

## Widget

While children run, a box above the editor lists them with elapsed time and live
status from Rex's program-status records (pi reports these itself):

| status | meaning |
|---|---|
| `starting` | no record yet (shell / devenv still loading) |
| `working` | pi has a turn in progress |
| `waiting for user` | turn finished, pane open — only with `autoExit: false` |
| `blocked: question/permission/auth` | pi is showing one of its own dialogs |
| `error` | last run failed and is not being retried |

## Debugging

- Every result steer carries the child's session path: `pi --session <path>` opens
  it, `subagent_resume` continues it.
- A crashed child's pane stays open with the error on screen; the same text is in
  the steer and in the `subagent_result` entry's `details.screen`. `details.command`
  is the exact argv — re-run it with
  `rex split --shell=none --keep-open -c <cwd> -- <argv…>`.
- Task and system-prompt files are under
  `<orchestrator session dir>/artifacts/<session id>/context/`.
- Env knobs: `PI_REX_PI_BIN` (pi binary for children, default `pi` on the child's
  PATH), `PI_REX_SPLIT_RATIO` (default 50).

## Layout

```
index.ts                     orchestrator: tools, commands, widget, steer wiring, re-attach
subagent-done.ts             child: subagent_done, caller_ping, auto-exit, handoff entry
launch/subagent-launch.zsh   static launcher (argv in, exec pi)
src/rex.ts                   rex CLI client: split, wait, capture, close, rename, send-key, program_status
src/watcher.ts               await rex wait → read transcript → classify
src/handoff.ts               the child↔parent contract + transcript reader
src/spawn.ts                 agent defs + params → session path, artifacts, argv
src/agents.ts                frontmatter parsing and discovery
src/seed.ts                  fork / lineage seeding, session id
src/messages.ts              outcome → steer message, renderers
src/widget.ts                running-children box
src/active.ts                nested-orchestrator guard
```

See `IDEAS.md` for what's next.

## License

MIT. Agent-definition semantics and the fork/lineage seeding approach follow
pi-interactive-subagents (MIT, HazAT).
