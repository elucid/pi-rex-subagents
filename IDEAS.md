# Ideas

Things worth doing after the basics, roughly in priority order. None are needed for
the daily workflow; all are small because the lifecycle code doesn't need to change
for any of them.

## Placement argument

Today every child splits right off the orchestrator's block (`PI_REX_SPLIT_RATIO`
sets the size). A `placement` param on `subagent` / `subagent_resume` — and a
`placement:` frontmatter default per agent — could express "vertical split above",
"narrow 30% on the left", or "new window". `rex split` already takes direction,
ratio, and anchor; a new window needs one `rex run` wrapper in `src/rex.ts`. The
watcher only knows block ids, so nothing else changes. ~50 lines.

Workaround today: ask the orchestrator to move the block after spawning
(`rex block move`).

## Stall signal

Rex's program status tells us a child is `working`, but not that it is spinning. A
cheap stall check on the 1 s widget tick: `working` for N minutes with no growth in
the child's session file → mark the row and optionally steer the orchestrator once.
herdr's version of this was dropped because its signal was screen-scraped; this one
would be truthful.

## Push instead of poll for status

The widget polls `rex block call program_status` once per running child per second.
`rex events -s SESSION --json` emits `program_status_changed` for every block; one
long-lived stream could replace the polling. Only worth it if the polling ever shows
up as cost.

## Unit tests

The pure modules are all seam-tested by design and have no tests yet:
`handoff.readChildTranscript`, `watcher.classifyTranscript`, `agents.parseAgentDefinition`,
`spawn.planSpawn` / `planResume` (argv shape), `widget.renderWidgetLines`, and
`rex.createRexClient` with a fake `exec`. `node --test` is already wired in
`package.json`.

## Env-var consolidation

The child receives `PI_SUBAGENT_NAME`, `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_AUTO_EXIT`,
`PI_DENY_TOOLS`. One `PI_SUBAGENT_CONFIG=<json file>` would be tidier and would let
the child extension grow options without touching the launcher. Low value until
there is a fifth variable.

## Orphan cleanup

If the orchestrator pi exits for good (not a reload or resume), finished children's
panes stay open because nobody closes them. A `/subagents-gc` command, or doing it
on the next orchestrator start for settled-but-still-existing blocks, would tidy
that. Rare enough to leave alone so far.
