// The child → parent handoff contract.
//
// The child appends ONE custom entry to its own session file via pi.appendEntry()
// right before it exits. The parent reads it after `rex wait` returns, when the
// process is gone and the file is final — so there is nothing to race against and
// no sidecar files. The entry also stays in the transcript as a record of what was
// handed off, visible on a later resume.
import { readFileSync } from "node:fs";

export const HANDOFF_TYPE = "subagent-handoff" as const;
export const HANDOFF_VERSION = 1 as const;

export interface ContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type Handoff =
  /** `subagent_done(summary)` — explicit report. */
  | { version: 1; kind: "done"; summary: string; contextUsage?: ContextUsageSnapshot }
  /** auto-exit after a clean agent_end — no explicit summary; use the transcript. */
  | { version: 1; kind: "auto-exit"; contextUsage?: ContextUsageSnapshot }
  /** `caller_ping(message)` — needs the parent; parent may resume with an answer. */
  | { version: 1; kind: "ping"; message: string; contextUsage?: ContextUsageSnapshot }
  /** session_shutdown without any of the above — the user quit pi. */
  | { version: 1; kind: "user-exit"; contextUsage?: ContextUsageSnapshot };

export interface ChildTranscript {
  handoff: Handoff | null;
  /** Last assistant text on disk, or null if the child never produced one. */
  lastAssistantText: string | null;
  /** Number of message entries — 0 means the child never got going (launch failure). */
  messageCount: number;
}

function isHandoff(v: unknown): v is Handoff {
  if (!v || typeof v !== "object") return false;
  const h = v as Record<string, unknown>;
  if (h.version !== HANDOFF_VERSION) return false;
  switch (h.kind) {
    case "done":
      return typeof h.summary === "string";
    case "ping":
      return typeof h.message === "string";
    case "auto-exit":
    case "user-exit":
      return true;
    default:
      return false;
  }
}

/**
 * Parse a child session file, considering only entries after `afterLine` non-blank
 * lines. The caller records the line count when it starts the child, so seeded
 * parent content (fork mode) and a previous run's handoff (resume) are never
 * mistaken for this run's output. Tolerates a missing file and bad lines.
 */
export function readChildTranscript(sessionFile: string, afterLine = 0): ChildTranscript {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return { handoff: null, lastAssistantText: null, messageCount: 0 };
  }

  let handoff: Handoff | null = null;
  let lastAssistantText: string | null = null;
  let messageCount = 0;

  let seen = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (seen++ < afterLine) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "custom" && entry.customType === HANDOFF_TYPE && isHandoff(entry.data)) {
      handoff = entry.data; // last one wins
    } else if (entry.type === "message") {
      messageCount++;
      const msg = entry.message;
      if (msg?.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n")
          .trim();
        if (text) lastAssistantText = text;
      }
    }
  }

  return { handoff, lastAssistantText, messageCount };
}
