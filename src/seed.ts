// Seeding a child session file before pi starts, for the non-standalone modes:
//   lineage-only — header only, with `parentSession` pointing at the orchestrator
//   fork         — header + the parent's conversation up to (not including) its
//                  last user message, so the child continues with full context
// The entry shapes are pi's version-3 session format (see docs/session-format.md);
// the approach is from pi-interactive-subagents (MIT, HazAT).
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function forkLines(parentSessionFile: string): string[] {
  const lines = readFileSync(parentSessionFile, "utf8").split("\n").filter((l) => l.trim());
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type === "message" && e.message?.role === "user") {
        cut = i;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  return lines.slice(0, cut).filter((l) => {
    try {
      return JSON.parse(l).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedChildSession(p: {
  mode: "lineage-only" | "fork";
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: p.childCwd,
    parentSession: p.parentSessionFile,
  };
  const lines = [JSON.stringify(header), ...(p.mode === "fork" ? forkLines(p.parentSessionFile) : [])];
  mkdirSync(dirname(p.childSessionFile), { recursive: true });
  writeFileSync(p.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/** Canonical session UUID from the header line (the filename's id is not always it). */
export function getSessionId(sessionFile: string): string | null {
  try {
    const first = readFileSync(sessionFile, "utf8").split("\n").find((l) => l.trim());
    const id = first ? JSON.parse(first).id : null;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Number of non-blank lines currently in a session file (0 if missing). */
export function countLines(sessionFile: string): number {
  try {
    return readFileSync(sessionFile, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}
