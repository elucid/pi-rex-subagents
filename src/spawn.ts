// Build the exact argv for a child pi and start it in a Rex block.
//
// The child's session path is chosen HERE, before it starts, so the parent can
// read the transcript afterwards (and seed it for fork/lineage modes later).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RexClient } from "./rex.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LAUNCHER = join(PACKAGE_ROOT, "launch", "subagent-launch.zsh");
export const CHILD_EXTENSION = join(PACKAGE_ROOT, "subagent-done.ts");

export interface ChildSpec {
  name: string;
  agent?: string;
  cwd: string;
  /** Directory the child's session file goes in (normally the parent's session dir). */
  sessionDir: string;
  /** Resume an existing session instead of starting a new one. */
  sessionFile?: string;
  autoExit: boolean;
  model?: string;
  tools?: string;
  denyTools?: string[];
  appendSystemPromptFile?: string;
  /** Initial prompt. Use an `@file` reference for long tasks. */
  prompt?: string;
  piBin?: string;
  extraPiArgs?: string[];
  direnv?: boolean;
}

export interface ChildPlan {
  sessionFile: string;
  /** Argv handed to `rex split -- …` verbatim. */
  command: string[];
  exports: string[];
}

export function newSessionFile(sessionDir: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(sessionDir, `${ts}_${randomUUID()}.jsonl`);
}

export function planChild(spec: ChildSpec): ChildPlan {
  const sessionFile = spec.sessionFile ?? newSessionFile(spec.sessionDir);

  const exports = [`PI_SUBAGENT_NAME=${spec.name}`];
  if (spec.agent) exports.push(`PI_SUBAGENT_AGENT=${spec.agent}`);
  if (spec.autoExit) exports.push("PI_SUBAGENT_AUTO_EXIT=1");
  if (spec.denyTools?.length) exports.push(`PI_DENY_TOOLS=${spec.denyTools.join(",")}`);

  const pi = [spec.piBin ?? "pi", "--session", sessionFile, "-e", CHILD_EXTENSION];
  if (spec.model) pi.push("--model", spec.model);
  if (spec.tools) pi.push("--tools", spec.tools);
  if (spec.appendSystemPromptFile) pi.push("--append-system-prompt", spec.appendSystemPromptFile);
  if (spec.extraPiArgs) pi.push(...spec.extraPiArgs);
  if (spec.prompt) pi.push(spec.prompt);

  const command = ["/bin/zsh", "-l", "-i", "-c", 'source "$0" "$@"', LAUNCHER, "--cwd", spec.cwd];
  for (const kv of exports) command.push("--export", kv);
  if (spec.direnv === false) command.push("--no-direnv");
  command.push("--", ...pi);

  return { sessionFile, command, exports };
}

/** Write the task to an artifact file and return the `@path` prompt for it. */
export function writeTaskArtifact(artifactDir: string, name: string, task: string): string {
  const dir = join(artifactDir, "context");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
  writeFileSync(file, task);
  return `@${file}`;
}

export async function startChild(
  rex: RexClient,
  plan: ChildPlan,
  opts: { anchor: string; cwd: string; label: string; ratio?: number },
): Promise<{ blockId: string }> {
  mkdirSync(dirname(plan.sessionFile), { recursive: true });
  return rex.split({
    anchor: opts.anchor,
    cwd: opts.cwd,
    label: opts.label,
    ratio: opts.ratio,
    command: plan.command,
    keepOpen: true,
    focus: false,
  });
}
