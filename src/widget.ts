// The orchestrator's "running sub-agents" box above the editor. Pure rendering:
// rows in, lines out. Status comes from Rex's program-status records for each
// child block (pi reports working/done/blocked/error itself), refreshed by the
// caller on a 1 s tick.
import type { ProgramStatus } from "./rex.ts";

export interface WidgetRow {
  name: string;
  agent?: string;
  startTime: number;
  status: ProgramStatus | null;
}

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const mmss = (startTime: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - startTime) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Plain-text status label; `blocked` says why. */
export function statusLabel(st: ProgramStatus | null): string {
  if (!st) return "starting";
  if (st.state === "blocked") return st.kind ? `blocked: ${st.kind}` : "blocked";
  return st.state;
}

function statusColor(st: ProgramStatus | null): string {
  switch (st?.state) {
    case "working": return "accent";
    case "blocked": return "warning";
    case "error": return "error";
    case "done": return "success";
    default: return "dim";
  }
}

// Border helpers work on visible width; callers pass already-styled fragments
// alongside their plain lengths so padding stays correct.
const top = (title: string, info: string, w: number): string => {
  const inner = Math.max(0, w - 2);
  const t = `─ ${title} `;
  const i = ` ${info} ─`;
  const fill = "─".repeat(Math.max(0, inner - t.length - i.length));
  return `╭${`${t}${fill}${i}`.slice(0, inner).padEnd(inner, "─")}╮`;
};
const bottom = (w: number): string => `╰${"─".repeat(Math.max(0, w - 2))}╯`;

export function renderWidgetLines(rows: WidgetRow[], width: number, theme: WidgetTheme, now = Date.now()): string[] {
  const w = Math.max(20, Math.floor(width));
  const inner = w - 2;
  const lines = [theme.fg("dim", top("Subagents", `${rows.length} running`, w))];

  for (const r of rows) {
    const leftPlain = ` ${mmss(r.startTime, now)}  ${r.name}${r.agent ? ` (${r.agent})` : ""}`;
    const rightPlain = ` ${statusLabel(r.status)} `;
    const room = Math.max(0, inner - rightPlain.length);
    const leftCut = leftPlain.length > room ? `${leftPlain.slice(0, Math.max(0, room - 1))}…` : leftPlain;
    const gap = " ".repeat(Math.max(0, inner - leftCut.length - rightPlain.length));
    const left = leftCut.replace(r.name, theme.bold(r.name));
    const right = theme.fg(statusColor(r.status), rightPlain);
    lines.push(`${theme.fg("dim", "│")}${left}${gap}${right}${theme.fg("dim", "│")}`);
  }

  lines.push(theme.fg("dim", bottom(w)));
  return lines;
}
