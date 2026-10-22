/**
 * Child-side extension, loaded into every subagent pi via `-e <this file>`.
 *
 * - `subagent_done(summary)` — the handoff. Appends a handoff entry to this
 *   session and exits; the parent delivers `summary` as the result.
 * - `caller_ping(message)` — ask the parent for help and exit; the parent can
 *   resume this session with an answer.
 * - Auto-exit: with PI_SUBAGENT_AUTO_EXIT=1, a clean agent_end ends the session
 *   (unless nested subagents are still running).
 * - A small widget above the editor showing the agent identity.
 *
 * Nothing here talks to Rex. The only output is the handoff entry in the session
 * file (see src/handoff.ts) and the process exit code, both of which the parent
 * observes natively.
 *
 * Identity arrives via env from the launcher: PI_SUBAGENT_NAME, PI_SUBAGENT_AGENT,
 * PI_SUBAGENT_AUTO_EXIT, PI_DENY_TOOLS.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { activeSubagentCount } from "./src/active.ts";
import { HANDOFF_TYPE, HANDOFF_VERSION, type ContextUsageSnapshot, type Handoff } from "./src/handoff.ts";

/**
 * Auto-exit only after a turn that ended cleanly. A turn ending on a user message
 * (request errored / retrying) or an aborted/errored assistant message leaves the
 * session open so pi can retry or the user can inspect.
 */
export function shouldAutoExit(messages: any[] | undefined, nestedActive: number): boolean {
  if (nestedActive > 0) return false;
  if (!messages?.length) return true;
  const last = messages[messages.length - 1];
  if (last?.role === "user") return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant") return m.stopReason !== "aborted" && m.stopReason !== "error";
  }
  return true;
}

export default function (pi: ExtensionAPI) {
  const name = process.env.PI_SUBAGENT_NAME ?? "subagent";
  const agent = process.env.PI_SUBAGENT_AGENT ?? "";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const denied = (process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  let handoffWritten = false;

  function contextUsage(ctx: { getContextUsage?: () => ContextUsageSnapshot | undefined }) {
    try {
      const u = ctx.getContextUsage?.();
      return u ? { tokens: u.tokens, contextWindow: u.contextWindow, percent: u.percent } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Append the handoff entry exactly once; later callers (agent_end after subagent_done, shutdown) no-op. */
  function writeHandoff(data: Omit<Handoff, "version">): void {
    if (handoffWritten) return;
    handoffWritten = true;
    pi.appendEntry(HANDOFF_TYPE, { version: HANDOFF_VERSION, ...data } as Handoff);
  }

  pi.on("session_start", (_e, ctx) => {
    if (!ctx.hasUI) return;
    const toolCount = pi.getAllTools().length;
    ctx.ui.setWidget(
      "subagent-identity",
      (_tui, theme) => {
        const box = new Box(1, 0, (t: string) => theme.bg("toolSuccessBg", t));
        const label = theme.bold(theme.fg("accent", `[${agent || name}]`));
        const mode = theme.fg("dim", autoExit ? " auto-exit" : " stays open");
        const tools = theme.fg("dim", ` · ${toolCount} tools`);
        const deny = denied.length ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`) : "";
        box.addChild(new Text(`${label}${mode}${tools}${deny}`, 0, 0));
        return box;
      },
      { placement: "aboveEditor" },
    );
  });

  pi.on("agent_end", (event, ctx) => {
    if (!autoExit) return;
    if (!shouldAutoExit(event.messages, activeSubagentCount())) return;
    writeHandoff({ kind: "auto-exit", contextUsage: contextUsage(ctx) });
    ctx.shutdown();
  });

  // The user quit pi (/quit, Ctrl+D) without subagent_done — record that honestly,
  // and still carry context usage.
  pi.on("session_shutdown", (_e, ctx) => {
    writeHandoff({ kind: "user-exit", contextUsage: contextUsage(ctx) });
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this when you have completed your task. It closes this session and delivers `summary` " +
      "to the caller as your result. The caller does NOT see your conversation, thinking, or files " +
      "you wrote — `summary` is the entire handoff, so put the full report in it (verdict, what you " +
      "did, key findings, paths to any artifacts). Do not announce the report in a separate message; pass it here.",
    parameters: Type.Object({
      summary: Type.String({ description: "Your complete final report for the caller, in markdown." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      writeHandoff({ kind: "done", summary: params.summary.trim(), contextUsage: contextUsage(ctx) });
      ctx.shutdown();
      return { content: [{ type: "text", text: "Handoff recorded. Shutting down." }], details: {} };
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. The parent is notified with " +
      "your message and can resume this session with a response. Use when you're stuck, need " +
      "clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      writeHandoff({ kind: "ping", message: params.message.trim(), contextUsage: contextUsage(ctx) });
      ctx.shutdown();
      return { content: [{ type: "text", text: "Ping sent. Shutting down." }], details: {} };
    },
  });
}
