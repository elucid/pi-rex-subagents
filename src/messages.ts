// Outcome → steer message (what wakes the orchestrator), and the renderers for
// those messages in the orchestrator's transcript. The customType strings
// `subagent_result` / `subagent_ping` are shared with pi-interactive-subagents
// so session greps and tooling keep working.
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import type { ContextUsageSnapshot } from "./handoff.ts";
import type { Outcome } from "./watcher.ts";

export interface SteerMessage {
  customType: "subagent_result" | "subagent_ping";
  content: string;
  display: true;
  details: Record<string, unknown>;
}

export interface RunningChild {
  id: string;
  name: string;
  agent?: string;
  task: string;
  blockId: string;
  sessionFile: string;
  startTime: number;
  command: string[];
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function usageLine(u: ContextUsageSnapshot | undefined | null): string {
  if (!u || u.tokens == null || u.percent == null || u.contextWindow <= 0) return "";
  const left = Math.max(0, u.contextWindow - u.tokens);
  return `Context: ${u.tokens.toLocaleString("en-US")}/${u.contextWindow.toLocaleString("en-US")} tokens (${Math.round(u.percent)}% used, ${left.toLocaleString("en-US")} remaining).`;
}

function sessionRef(sessionFile: string, sessionId: string | null): string {
  return `Session: ${sessionId ?? sessionFile}\nResume: subagent_resume with sessionPath ${sessionFile}`;
}

function screenSection(screen: string | null): string {
  if (screen == null) return "Pane output unavailable (capture failed or pane already gone).";
  const s = screen.trim();
  return s ? `Pane output:\n${s}` : "Pane produced no output.";
}

export function buildSteer(
  child: RunningChild,
  outcome: Outcome,
  opts: { sessionId: string | null; now?: number },
): SteerMessage | null {
  const elapsed = Math.max(0, Math.floor(((opts.now ?? Date.now()) - child.startTime) / 1000));
  const usage = "contextUsage" in outcome ? outcome.contextUsage : undefined;
  const base = {
    id: child.id,
    name: child.name,
    agent: child.agent,
    task: child.task,
    elapsed,
    blockId: child.blockId,
    sessionFile: child.sessionFile,
    sessionId: opts.sessionId,
    disposition: outcome.kind,
    ...(usage ? { contextUsage: usage } : {}),
  };
  const tail = [sessionRef(child.sessionFile, opts.sessionId), usageLine(usage)].filter(Boolean).join("\n");
  const q = (s: string) => `Sub-agent "${child.name}"${child.agent ? ` (${child.agent})` : ""} ${s}`;

  switch (outcome.kind) {
    case "cancelled":
      return null;

    case "completed":
      return {
        customType: "subagent_result",
        content: `${q(`completed (${formatElapsed(elapsed)}).`)}\n\n${outcome.summary}\n\n${tail}`,
        display: true,
        details: { ...base, exitCode: 0, summary: outcome.summary, summarySource: outcome.source },
      };

    case "ping":
      return {
        customType: "subagent_ping",
        content: `${q(`needs help (${formatElapsed(elapsed)}):`)}\n\n${outcome.message}\n\n${tail}`,
        display: true,
        details: { ...base, message: outcome.message },
      };

    case "user-exit":
      return {
        customType: "subagent_result",
        content:
          `${q(`exited after ${formatElapsed(elapsed)}: session closed by the user, no subagent_done.`)}` +
          ` Last message:\n\n${outcome.lastMessage ?? "(none)"}\n\n${tail}`,
        display: true,
        details: { ...base, exitCode: 0, summary: outcome.lastMessage },
      };

    case "failed": {
      const head = outcome.launchFailure
        ? q(`failed to launch (exit ${outcome.exitCode}). The pane was left open for post-mortem.`)
        : q(`crashed (exit ${outcome.exitCode}) after ${formatElapsed(elapsed)}. The pane was left open for post-mortem.`);
      const last = outcome.lastMessage ? `Last message:\n\n${outcome.lastMessage}\n\n` : "";
      return {
        customType: "subagent_result",
        content: `${head}\n\n${last}${screenSection(outcome.screen)}\n\nBlock: ${child.blockId}\n${tail}`,
        display: true,
        details: {
          ...base,
          exitCode: outcome.exitCode,
          error: outcome.launchFailure ? "launch-failed" : "crashed",
          summary: outcome.lastMessage,
          screen: outcome.screen,
          command: child.command,
        },
      };
    }

    case "killed":
      return {
        customType: "subagent_result",
        content:
          `${q("was closed externally before completion (block closed, no exit recorded). Last message:")}\n\n` +
          `${outcome.lastMessage ?? "(none)"}\n\n${tail}`,
        display: true,
        details: { ...base, error: "killed", summary: outcome.lastMessage },
      };

    case "lost":
      return {
        customType: "subagent_result",
        content:
          `${q(`could not be observed to completion: ${outcome.message}.`)} It may still be running in block ${child.blockId}. Last message:\n\n` +
          `${outcome.lastMessage ?? "(none)"}\n\n${tail}`,
        display: true,
        details: { ...base, error: "lost", summary: outcome.lastMessage },
      };
  }
}

// ── renderers ────────────────────────────────────────────────────────────────

type Theme = { fg(c: string, t: string): string; bg(c: string, t: string): string; bold(t: string): string };

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "expand for more";
  }
}

function statusText(d: Record<string, any>): string {
  switch (d.disposition) {
    case "completed": return "completed";
    case "user-exit": return "closed by user (no subagent_done)";
    case "failed": return d.error === "launch-failed" ? `failed to launch (exit ${d.exitCode})` : `crashed (exit ${d.exitCode})`;
    case "killed": return "closed externally";
    case "lost": return "lost";
    default: return String(d.disposition ?? "?");
  }
}

function lines(theme: Theme, d: Record<string, any>, header: string, body: string, extra: string[], expanded: boolean, width: number): string[] {
  const out = [header];
  const u = usageLine(d.contextUsage);
  if (u) out.push(theme.fg("dim", u));
  // Never width-truncated: these exist to be copy-pasted.
  if (d.sessionFile) out.push(theme.fg("dim", `Session: ${d.sessionId ?? d.sessionFile}`));
  if (expanded) {
    if (d.sessionId) out.push(theme.fg("dim", `Path:    ${d.sessionFile}`));
    if (body) out.push("", ...body.split("\n").map((l) => l.slice(0, width - 6)));
    if (extra.length) out.push("", ...extra.map((l) => l.slice(0, width - 6)));
  } else {
    const all = body.split("\n");
    for (const l of all.slice(0, 5)) out.push(theme.fg("dim", l.slice(0, width - 6)));
    if (all.length > 5) out.push(theme.fg("muted", `… ${all.length - 5} more lines`));
    out.push(theme.fg("muted", expandHint()));
  }
  return out;
}

export function renderResult(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme) {
  const d = message.details as Record<string, any> | undefined;
  if (!d) return undefined;
  return {
    invalidate() {},
    render(width: number): string[] {
      const ok = d.disposition === "completed" || d.disposition === "user-exit";
      const icon = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const tag = d.agent ? theme.fg("dim", ` (${d.agent})`) : "";
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(d.name ?? "subagent"))}${tag} ${theme.fg("dim", "—")} ${statusText(d)} ${theme.fg("dim", `(${formatElapsed(d.elapsed ?? 0)})`)}`;
      const extra = "screen" in d ? screenSection(d.screen).split("\n") : [];
      const box = new Box(1, 1, (t: string) => theme.bg(ok ? "toolSuccessBg" : "toolErrorBg", t));
      box.addChild(new Text(lines(theme, d, header, d.summary ?? "", extra, options.expanded, width).join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

export function renderPing(message: { details?: unknown }, options: { expanded: boolean }, theme: Theme) {
  const d = message.details as Record<string, any> | undefined;
  if (!d) return undefined;
  return {
    invalidate() {},
    render(width: number): string[] {
      const tag = d.agent ? theme.fg("dim", ` (${d.agent})`) : "";
      const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(d.name ?? "subagent"))}${tag} ${theme.fg("dim", "— needs help")}`;
      const box = new Box(1, 1, (t: string) => theme.bg("toolSuccessBg", t));
      box.addChild(new Text(lines(theme, d, header, d.message ?? "", [], options.expanded, width).join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}
