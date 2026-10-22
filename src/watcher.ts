// Lifecycle of one child: wait for its process to exit, read what it left in its
// session file, and close its block. One `rex wait` per child is the only signal
// source — no sidecars, no event stream, no polling.
//
// Blocks are spawned with --keep-open so the screen survives a crash: on a nonzero
// exit the block is captured and LEFT OPEN for the user; on a clean exit it is
// closed immediately.
import { type ChildTranscript, readChildTranscript, type ContextUsageSnapshot } from "./handoff.ts";
import type { RexClient } from "./rex.ts";

export type Outcome =
  | { kind: "completed"; summary: string; source: "handoff" | "transcript"; contextUsage?: ContextUsageSnapshot }
  | { kind: "ping"; message: string; contextUsage?: ContextUsageSnapshot }
  | { kind: "user-exit"; lastMessage: string | null; contextUsage?: ContextUsageSnapshot }
  | { kind: "failed"; exitCode: number; error?: string; screen: string | null; lastMessage: string | null; launchFailure: boolean }
  | { kind: "killed"; lastMessage: string | null }
  | { kind: "lost"; message: string; lastMessage: string | null }
  | { kind: "cancelled" };

export interface WatchedChild {
  blockId: string;
  sessionFile: string;
  transcriptStartLine?: number;
}

/**
 * What a child that ended cleanly (or whose block is simply gone) left behind.
 * The handoff entry is authoritative; with none, the exit was the user's.
 */
export function classifyTranscript(t: ChildTranscript, fallback: Outcome): Outcome {
  const h = t.handoff;
  if (h?.kind === "done") {
    return h.summary
      ? { kind: "completed", summary: h.summary, source: "handoff", contextUsage: h.contextUsage }
      : { kind: "completed", summary: t.lastAssistantText ?? "(no summary)", source: "transcript", contextUsage: h.contextUsage };
  }
  if (h?.kind === "auto-exit") {
    return { kind: "completed", summary: t.lastAssistantText ?? "(no final message)", source: "transcript", contextUsage: h.contextUsage };
  }
  if (h?.kind === "ping") return { kind: "ping", message: h.message, contextUsage: h.contextUsage };
  if (h?.kind === "user-exit") return { kind: "user-exit", lastMessage: t.lastAssistantText, contextUsage: h.contextUsage };
  return fallback;
}

export async function watchChild(rex: RexClient, child: WatchedChild, signal?: AbortSignal): Promise<Outcome> {
  const result = await rex.wait(child.blockId, signal);
  if (signal?.aborted) return { kind: "cancelled" };

  const t = readChildTranscript(child.sessionFile, child.transcriptStartLine ?? 0);

  switch (result.kind) {
    case "closed":
      // Block gone without an exit we saw. If the child handed off before that
      // (e.g. it finished while nobody was watching), honour the handoff.
      return classifyTranscript(t, { kind: "killed", lastMessage: t.lastAssistantText });

    case "lost":
      return { kind: "lost", message: result.message, lastMessage: t.lastAssistantText };

    case "exited": {
      if (result.exitCode !== 0) {
        const screen = await rex.capture(child.blockId);
        return {
          kind: "failed",
          exitCode: result.exitCode,
          error: result.error,
          screen,
          lastMessage: t.lastAssistantText,
          launchFailure: t.messageCount === 0,
        };
      }
      // Clean exit: nothing left to read on screen; free the pane.
      await rex.close(child.blockId).catch(() => {});
      return classifyTranscript(t, { kind: "user-exit", lastMessage: t.lastAssistantText });
    }
  }
}

/** For a child whose block no longer exists at all (re-attach after a reload). */
export function classifyGoneChild(child: WatchedChild): Outcome {
  const t = readChildTranscript(child.sessionFile, child.transcriptStartLine ?? 0);
  return classifyTranscript(t, { kind: "killed", lastMessage: t.lastAssistantText });
}
