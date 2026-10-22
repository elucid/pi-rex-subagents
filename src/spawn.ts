// Plan a child launch: resolve agent defaults + tool params into a child session
// path, artifact files, and the exact argv for `rex split`.
//
// The child's session path is chosen here, before it starts, so the parent can
// read the transcript afterwards and seed it for fork/lineage modes.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AgentDefinition, resolveChildCwd, resolveChildSessionDir, resolveDenyTools } from "./agents.ts";
import { countLines, seedChildSession } from "./seed.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const LAUNCHER = join(PACKAGE_ROOT, "launch", "subagent-launch.zsh");
export const CHILD_EXTENSION = join(PACKAGE_ROOT, "subagent-done.ts");

/** Tools the child always keeps, whatever its allowlist says. */
const CHILD_CONTROL_TOOLS = ["subagent_done", "caller_ping"];

export interface SpawnParams {
  name: string;
  task: string;
  agent?: string;
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  skills?: string;
  tools?: string;
  cwd?: string;
  fork?: boolean;
  autoExit?: boolean;
}

export interface PlanContext {
  parentCwd: string;
  parentSessionFile: string;
  /** `<parent session dir>/artifacts/<parent session id>` */
  artifactDir: string;
  piBin?: string;
  now?: Date;
}

export interface ChildPlan {
  name: string;
  agent?: string;
  cwd: string;
  sessionFile: string;
  /** Non-blank lines in the session file before the child starts (0 for a blank session). */
  transcriptStartLine: number;
  autoExit: boolean;
  /** Argv handed to `rex split -- …` verbatim. */
  command: string[];
  files: Array<{ path: string; content: string }>;
  seed?: Parameters<typeof seedChildSession>[0];
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "subagent";

function launcherArgv(cwd: string, exports: string[], pi: string[]): string[] {
  const cmd = ["/bin/zsh", "-l", "-i", "-c", 'source "$0" "$@"', LAUNCHER, "--cwd", cwd];
  for (const kv of exports) cmd.push("--export", kv);
  cmd.push("--", ...pi);
  return cmd;
}

function childExports(p: { name: string; agent?: string; autoExit: boolean; denyTools: string[] }): string[] {
  const out = [`PI_SUBAGENT_NAME=${p.name}`];
  if (p.agent) out.push(`PI_SUBAGENT_AGENT=${p.agent}`);
  if (p.autoExit) out.push("PI_SUBAGENT_AUTO_EXIT=1");
  if (p.denyTools.length) out.push(`PI_DENY_TOOLS=${p.denyTools.join(",")}`);
  return out;
}

function toolAllowlist(tools: string | undefined): string | null {
  const requested = (tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!requested.length) return null;
  return [...new Set([...requested, ...CHILD_CONTROL_TOOLS])].join(",");
}

/** `/skill:x` prompts must be separate positional messages; the task comes last. */
function promptArgs(skills: string | undefined, task: string, viaArtifact: boolean): string[] {
  const skillPrompts = (skills ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => `/skill:${s}`);
  // With an @file task, pi folds the first positional into the file message, which
  // would swallow a leading /skill: — an empty first message keeps them separate.
  const sep = viaArtifact && skillPrompts.length ? [""] : [];
  return [...sep, ...skillPrompts, task];
}

export function planSpawn(params: SpawnParams, def: AgentDefinition | null, ctx: PlanContext): ChildPlan {
  const now = ctx.now ?? new Date();
  const name = safeName(params.name);
  const cwd = resolveChildCwd(params.cwd, def, ctx.parentCwd);
  const { sessionDir } = resolveChildSessionDir(cwd);
  const sessionFile = join(sessionDir, `${now.toISOString().replace(/[:.]/g, "-")}_${randomUUID()}.jsonl`);

  // Bare spawns are autonomous by default; agent defs and /iterate say otherwise explicitly.
  const autoExit = params.autoExit ?? def?.autoExit ?? true;
  const sessionMode = params.fork ? "fork" : (def?.sessionMode ?? "standalone");
  const files: ChildPlan["files"] = [];

  // ── task message ──
  const modeHint = autoExit
    ? "Complete your task autonomously. When finished, call the subagent_done tool."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const handoffHint =
    "Hand off your results by passing your complete final report as the `summary` argument of subagent_done. " +
    "The caller receives ONLY that argument — not your messages, thinking, or files you wrote — " +
    "so include the verdict, what you did, key findings, and paths to any artifacts." +
    (autoExit ? "" : " If the user closes the session instead, your last assistant message is used.");
  const role = def?.body ?? params.systemPrompt;
  const roleInSystemPrompt = Boolean(def?.systemPromptMode && role);

  let taskArg: string;
  if (sessionMode === "fork") {
    taskArg = params.task; // the child already has the conversation
  } else {
    const text = [!roleInSystemPrompt && role, modeHint, params.task, handoffHint].filter(Boolean).join("\n\n");
    const file = join(ctx.artifactDir, "context", `${name}-${stamp(now)}.md`);
    files.push({ path: file, content: text });
    taskArg = `@${file}`;
  }

  // ── pi argv ──
  const pi = [ctx.piBin ?? "pi", "--session", sessionFile, "-e", CHILD_EXTENSION];
  const model = params.model ?? def?.model;
  const thinking = params.thinking ?? def?.thinking;
  if (model) pi.push("--model", model);
  if (thinking) pi.push("--thinking", thinking);
  if (roleInSystemPrompt && role) {
    const file = join(ctx.artifactDir, "context", `${name}-sysprompt-${stamp(now)}.md`);
    files.push({ path: file, content: role });
    pi.push(def!.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", file);
  }
  const allow = toolAllowlist(params.tools ?? def?.tools);
  if (allow) pi.push("--tools", allow);
  pi.push(...promptArgs(params.skills ?? def?.skills, taskArg, sessionMode !== "fork"));

  const exports = childExports({ name: params.name, agent: params.agent, autoExit, denyTools: resolveDenyTools(def) });

  return {
    name: params.name,
    agent: params.agent,
    cwd,
    sessionFile,
    transcriptStartLine: 0, // set by materialize() after seeding
    autoExit,
    command: launcherArgv(cwd, exports, pi),
    files,
    seed:
      sessionMode === "standalone"
        ? undefined
        : { mode: sessionMode, parentSessionFile: ctx.parentSessionFile, childSessionFile: sessionFile, childCwd: cwd },
  };
}

export interface ResumeParams {
  sessionPath: string;
  name?: string;
  message?: string;
  autoExit?: boolean;
}

export function planResume(params: ResumeParams, ctx: PlanContext): ChildPlan {
  const now = ctx.now ?? new Date();
  const name = params.name ?? "Resume";
  const autoExit = params.autoExit ?? true;
  const cwd = ctx.parentCwd;
  const files: ChildPlan["files"] = [];

  const pi = [ctx.piBin ?? "pi", "--session", params.sessionPath, "-e", CHILD_EXTENSION];
  if (params.message) {
    const file = join(ctx.artifactDir, "resume", `${safeName(name)}-${stamp(now)}.md`);
    files.push({ path: file, content: params.message });
    pi.push(`@${file}`);
  }

  const exports = childExports({ name, autoExit, denyTools: [] });
  return {
    name,
    cwd,
    sessionFile: params.sessionPath,
    transcriptStartLine: countLines(params.sessionPath),
    autoExit,
    command: launcherArgv(cwd, exports, pi),
    files,
  };
}

/** Write artifact files and seed the session (if planned); fixes transcriptStartLine. */
export function materialize(plan: ChildPlan): ChildPlan {
  for (const f of plan.files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.content, "utf8");
  }
  if (plan.seed) seedChildSession(plan.seed);
  mkdirSync(dirname(plan.sessionFile), { recursive: true });
  return { ...plan, transcriptStartLine: countLines(plan.sessionFile) };
}
