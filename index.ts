/**
 * pi-rex-subagents — orchestrator side.
 *
 * Registers `subagent`, `subagent_resume`, `subagent_interrupt`, `subagents_list`
 * and the `/subagent`, `/iterate` commands when pi is running inside a Rex
 * terminal. Each spawned child is one Rex block beside this one, one `rex wait`,
 * and one steer message back when it ends (see src/watcher.ts, src/messages.ts).
 *
 * Outside Rex nothing is registered except the message renderers, so past
 * results still display.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { markSubagentActive, markSubagentInactive } from "./src/active.ts";
import { discoverAgentDefinitions, getAgentConfigDir, loadAgentDefinition } from "./src/agents.ts";
import { buildSteer, formatElapsed, renderPing, renderResult, type RunningChild } from "./src/messages.ts";
import { createRexClient, insideRex, type ProgramStatus, type RexClient } from "./src/rex.ts";
import { getSessionId } from "./src/seed.ts";
import { type ChildPlan, materialize, planResume, planSpawn } from "./src/spawn.ts";
import { classifyGoneChild, type Outcome, watchChild } from "./src/watcher.ts";
import { renderWidgetLines, type WidgetRow } from "./src/widget.ts";

// ── state ───────────────────────────────────────────────────────────────────

const running = new Map<string, RunningChild & { abort: AbortController }>();
let rex: RexClient;
let ui: { setWidget: Function; notify: Function } | null = null;
let widgetTimer: ReturnType<typeof setInterval> | null = null;

const ok = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], details: { error: text } });

// ── widget: running children ────────────────────────────────────────────────

const statusCache = new Map<string, ProgramStatus | null>();

function widgetRows(): WidgetRow[] {
  return [...running.values()].map((c) => ({ name: c.name, agent: c.agent, startTime: c.startTime, status: statusCache.get(c.blockId) ?? null }));
}

/** One cheap `rex` call per running child; results land on the next render. */
async function pollStatuses(): Promise<void> {
  await Promise.all([...running.values()].map(async (c) => statusCache.set(c.blockId, await rex.programStatus(c.blockId))));
}

function refreshWidget(): void {
  if (!ui) return;
  if (running.size === 0) {
    ui.setWidget("rex-subagents", undefined);
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = null;
    statusCache.clear();
    return;
  }
  ui.setWidget(
    "rex-subagents",
    (_tui: unknown, theme: any) => ({
      invalidate() {},
      render: (width: number) => renderWidgetLines(widgetRows(), width, theme),
    }),
    { placement: "aboveEditor" },
  );
  if (!widgetTimer) {
    widgetTimer = setInterval(() => void pollStatuses().then(refreshWidget), 1000);
    void pollStatuses().then(refreshWidget);
  }
}

// ── launch + watch ──────────────────────────────────────────────────────────

function planContext(ctx: any) {
  const sm = ctx.sessionManager;
  return {
    parentCwd: ctx.cwd as string,
    parentSessionFile: (sm.getSessionFile() as string | undefined) ?? "",
    artifactDir: join(sm.getSessionDir(), "artifacts", sm.getSessionId()),
    piBin: process.env.PI_REX_PI_BIN,
  };
}

/**
 * Each spawn is recorded in the orchestrator's own session (not model context),
 * and marked settled once its steer is delivered. On session_start the
 * difference is re-attached, so /reload and `pi --session` resume never orphan a
 * running child or lose a result that landed while nobody was watching.
 */
const RUNNING_TYPE = "subagent-running";
const SETTLED_TYPE = "subagent-settled";

type ChildRecord = RunningChild & { transcriptStartLine: number };

function deliver(pi: ExtensionAPI, child: RunningChild, outcome: Outcome): void {
  const msg = buildSteer(child, outcome, { sessionId: getSessionId(child.sessionFile) });
  if (!msg) return; // cancelled: we are shutting down; leave the record unsettled for re-attach
  pi.appendEntry(SETTLED_TYPE, { id: child.id, blockId: child.blockId });
  pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" });
}

function armWatcher(pi: ExtensionAPI, rec: ChildRecord): void {
  const child = { ...rec, abort: new AbortController() };
  running.set(child.id, child);
  markSubagentActive(child.id);
  refreshWidget();

  void watchChild(rex, { blockId: rec.blockId, sessionFile: rec.sessionFile, transcriptStartLine: rec.transcriptStartLine }, child.abort.signal)
    .then((outcome) => deliver(pi, child, outcome))
    .catch((e: any) => deliver(pi, child, { kind: "lost", message: String(e?.message ?? e), lastMessage: null }))
    .finally(() => {
      running.delete(child.id);
      markSubagentInactive(child.id);
      refreshWidget();
    });
}

async function launch(pi: ExtensionAPI, plan: ChildPlan, task: string): Promise<ReturnType<typeof ok>> {
  const p = materialize(plan);
  let blockId: string;
  try {
    ({ blockId } = await rex.split({
      anchor: process.env.REX_BLOCK!,
      cwd: p.cwd,
      label: p.name,
      command: p.command,
      ratio: Number(process.env.PI_REX_SPLIT_RATIO ?? 50),
      keepOpen: true,
      focus: false,
    }));
  } catch (e: any) {
    return fail(`Failed to start a Rex block for "${p.name}": ${e?.message ?? e}`);
  }

  const id = blockId.slice(-6);
  const rec: ChildRecord = {
    id, name: p.name, agent: p.agent, task, blockId, sessionFile: p.sessionFile,
    startTime: Date.now(), command: p.command, transcriptStartLine: p.transcriptStartLine,
  };
  pi.appendEntry(RUNNING_TYPE, rec);
  armWatcher(pi, rec);

  return ok(
    `Sub-agent "${p.name}" is running in Rex block ${blockId} (id ${id}). ` +
      "Do NOT assume or invent its results. They will be delivered to you automatically as a steer message when it finishes; " +
      "until then, work on other things or end your turn.",
    { id, name: p.name, agent: p.agent, blockId, sessionFile: p.sessionFile, autoExit: p.autoExit, status: "started" },
  );
}

/** Children recorded in this session that never got a settled entry. */
function unsettledChildren(entries: any[]): ChildRecord[] {
  const started = new Map<string, ChildRecord>();
  for (const e of entries) {
    if (e?.type !== "custom") continue;
    if (e.customType === RUNNING_TYPE && e.data?.blockId) started.set(e.data.blockId, e.data as ChildRecord);
    if (e.customType === SETTLED_TYPE && e.data?.blockId) started.delete(e.data.blockId);
  }
  return [...started.values()];
}

async function reattach(pi: ExtensionAPI, entries: any[]): Promise<void> {
  for (const rec of unsettledChildren(entries)) {
    if (running.has(rec.id)) continue;
    if (await rex.exists(rec.blockId)) {
      armWatcher(pi, rec); // rex wait returns at once if the program already exited
    } else {
      deliver(pi, { ...rec }, classifyGoneChild(rec));
    }
  }
}

// ── tools ───────────────────────────────────────────────────────────────────

const ASYNC_NOTE =
  "This is a fire-and-forget async tool: it returns immediately with an acknowledgement. When the sub-agent finishes, " +
  "its result is AUTOMATICALLY delivered as a steer message that starts a new turn for you. Do NOT poll, sleep, tail files, " +
  "or call other tools to check on it, and do NOT fabricate results. After calling it, either end your turn or do other " +
  "independent work (including spawning more sub-agents in parallel).";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name (also the Rex block label)" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(Type.String({ description: "Agent definition to load defaults from (e.g. 'worker', 'scout', 'reviewer'); see subagents_list" })),
  systemPrompt: Type.Optional(Type.String({ description: "Role instructions (used when no agent is given)" })),
  model: Type.Optional(Type.String({ description: "Model override in provider/id form, e.g. 'anthropic/claude-opus-5-5'" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override: off, minimal, low, medium, high, xhigh, max" })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills (overrides the agent's)" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist (overrides the agent's)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent (default: yours)" })),
  fork: Type.Optional(Type.Boolean({ description: "Fork this conversation: the sub-agent starts with your full context" })),
  autoExit: Type.Optional(
    Type.Boolean({
      description:
        "Override the agent's `auto-exit`. true: the sub-agent closes itself when its task is done (autonomous work). " +
        "false: it stays open after answering so the user can keep interacting in its pane (interactive reviews, pairing); " +
        "it ends when it calls subagent_done or the user quits it.",
    }),
  ),
});

function registerTools(pi: ExtensionAPI, denied: Set<string>): void {
  if (!denied.has("subagent")) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: `Spawn a sub-agent (a new pi) in a Rex pane beside you. ${ASYNC_NOTE}`,
      promptSnippet: "Spawn a sub-agent in a Rex pane; its result arrives later as a steer message.",
      promptGuidelines: [
        "Sub-agents run in their own Rex pane beside you and close that pane themselves when done (autoExit defaults to true, " +
          "unless the agent definition says auto-exit: false). When the user wants to keep interacting with a sub-agent in its " +
          "pane (review, pairing, 'leave it open'), pass autoExit: false; it then ends only when it calls subagent_done or the user quits it.",
        "Prefer a named agent definition (subagents_list) when one fits; any field (model, thinking, tools, autoExit, cwd) can be " +
          "overridden per call. Results always arrive as a steer message with the child's session path, which subagent_resume can continue.",
      ],
      parameters: SubagentParams,
      async execute(_id, params, _signal, _update, ctx) {
        const me = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && me && params.agent === me) {
          return fail(`You are the ${me} agent — do not spawn another ${me}; do the work yourself.`);
        }
        const def = params.agent ? loadAgentDefinition(params.agent, ctx.cwd) : null;
        if (params.agent && !def) {
          return fail(`Agent "${params.agent}" not found in ${join(ctx.cwd, ".pi/agents")} or ${join(getAgentConfigDir(), "agents")}.`);
        }
        let plan: ChildPlan;
        try {
          plan = planSpawn(params, def, planContext(ctx));
        } catch (e: any) {
          return fail(`Failed to plan launch: ${e?.message ?? e}`);
        }
        return launch(pi, plan, params.task);
      },
      renderCall(args: any, theme) {
        const name = args.name || "(unnamed)";
        const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
        const first = String(args.task ?? "").split("\n").find((l: string) => l.trim()) ?? "";
        const preview = first.length > 100 ? `${first.slice(0, 100)}…` : first;
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold(name))}${agent}${preview ? `\n${theme.fg("toolOutput", preview)}` : ""}`, 0, 0);
      },
      renderResult(result, _o, theme) {
        const d = result.details as any;
        if (d?.status === "started") return new Text(`${theme.fg("accent", "▸")} ${theme.bold(d.name)} ${theme.fg("dim", `— started in ${d.blockId?.slice(-6)}`)}`, 0, 0);
        return new Text(theme.fg("dim", String((result.content[0] as any)?.text ?? "")), 0, 0);
      },
    });
  }

  if (!denied.has("subagent_resume")) {
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description: `Resume a previous sub-agent session in a new Rex pane, optionally with a follow-up message. ${ASYNC_NOTE}`,
      promptSnippet: "Resume a sub-agent session with a follow-up; result arrives as a steer message.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl to resume" }),
        name: Type.Optional(Type.String({ description: "Display name (default 'Resume')" })),
        message: Type.Optional(Type.String({ description: "Follow-up instructions sent on resume" })),
        autoExit: Type.Optional(Type.Boolean({ description: "Close itself when done (default true); false keeps it open for the user" })),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        if (!existsSync(params.sessionPath)) return fail(`Session file not found: ${params.sessionPath}`);
        return launch(pi, planResume(params, planContext(ctx)), params.message ?? "resumed session");
      },
      renderCall(args: any, theme) {
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold(args.name ?? "Resume"))} ${theme.fg("dim", "— resuming")}`, 0, 0);
      },
    });
  }

  if (!denied.has("subagent_interrupt")) {
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description: "Send Escape to a running sub-agent's current turn. The pane and session stay alive; no result is produced by this call.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Running sub-agent id" })),
        name: Type.Optional(Type.String({ description: "Running sub-agent display name" })),
      }),
      async execute(_id, params) {
        let target = params.id ? running.get(params.id) : undefined;
        if (!target && params.name) {
          const m = [...running.values()].filter((c) => c.name === params.name);
          if (m.length > 1) return fail(`Ambiguous name "${params.name}": ${m.map((c) => c.id).join(", ")}`);
          target = m[0];
        }
        if (!target) return fail(`No running sub-agent matches ${JSON.stringify(params)}. Running: ${[...running.values()].map((c) => `${c.name} [${c.id}]`).join(", ") || "none"}`);
        await rex.sendKey(target.blockId, "escape");
        return ok(`Escape sent to "${target.name}".`, { id: target.id, name: target.name });
      },
    });
  }

  if (!denied.has("subagents_list")) {
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description: "List available sub-agent definitions (project .pi/agents/ overrides global ~/.pi/agent/agents/) and the sub-agents currently running.",
      parameters: Type.Object({}),
      async execute(_id, _p, _s, _u, ctx) {
        const defs = discoverAgentDefinitions(ctx.cwd).filter((a) => !a.disableModelInvocation);
        const lines = defs.map((a) => `• ${a.name}${a.source === "project" ? " (project)" : ""}${a.model ? ` [${a.model}]` : ""}${a.autoExit === false ? " (stays open)" : ""}${a.description ? ` — ${a.description}` : ""}`);
        const run = [...running.values()].map((c) => `• ${c.name} [${c.id}]${c.agent ? ` (${c.agent})` : ""} — ${formatElapsed(Math.floor((Date.now() - c.startTime) / 1000))}`);
        return ok(`Definitions:\n${lines.join("\n") || "(none)"}\n\nRunning:\n${run.join("\n") || "(none)"}`, { agents: defs, running: [...running.values()].map(({ abort, ...c }) => c) });
      },
    });
  }
}

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("subagent", {
    description: "Spawn a sub-agent: /subagent <agent> [task]",
    handler: async (args, ctx) => {
      const t = args.trim();
      if (!t) return void ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
      const i = t.indexOf(" ");
      const agent = i === -1 ? t : t.slice(0, i);
      const task = i === -1 ? `You are the ${agent} agent. Wait for instructions.` : t.slice(i + 1).trim();
      if (!loadAgentDefinition(agent, ctx.cwd)) return void ctx.ui.notify(`Agent "${agent}" not found`, "error");
      pi.sendUserMessage(`Use subagent with agent: "${agent}", name: "${agent[0].toUpperCase()}${agent.slice(1)}", task: ${JSON.stringify(task)}`);
    },
  });
  pi.registerCommand("iterate", {
    description: "Fork this session into an interactive sub-agent pane: /iterate [task]",
    handler: async (args) => {
      const task = args.trim() || "The user wants to do some hands-on work. Help them with whatever they need.";
      pi.sendUserMessage(`Use subagent to fork this session: fork: true, autoExit: false, name: "Iterate", task: ${JSON.stringify(task)}`);
    },
  });
}

// ── entry ───────────────────────────────────────────────────────────────────

export default function rexSubagents(pi: ExtensionAPI) {
  pi.registerMessageRenderer("subagent_result", (m, o, t) => renderResult(m as any, o, t as any));
  pi.registerMessageRenderer("subagent_ping", (m, o, t) => renderPing(m as any, o, t as any));

  if (!insideRex()) return;

  rex = createRexClient();
  const denied = new Set((process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  registerTools(pi, denied);
  registerCommands(pi);

  pi.on("session_start", (_e, ctx) => {
    ui = ctx.hasUI ? ctx.ui : null;
    refreshWidget();
    void reattach(pi, ctx.sessionManager.getEntries() as any[]).catch((e: any) => {
      ui?.notify(`pi-rex-subagents: re-attach failed: ${e?.message ?? e}`, "warning");
    });
  });

  pi.on("session_shutdown", () => {
    for (const c of running.values()) {
      c.abort.abort();
      markSubagentInactive(c.id);
    }
    running.clear();
    refreshWidget();
    ui = null;
  });
}
