// Agent definitions: `~/.pi/agent/agents/*.md` and `.pi/agents/*.md` with YAML-ish
// frontmatter. The field names and the line-regex parser follow
// pi-interactive-subagents (MIT, HazAT) so existing definitions keep working.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefinition {
  name: string;
  description?: string;
  /** provider/id form, e.g. anthropic/claude-opus-5-5. */
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SessionMode;
  cwd?: string;
  /** Markdown body: role instructions. */
  body?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: "global" | "project";
}

export const SPAWNING_TOOLS = ["subagent", "subagent_resume", "subagent_interrupt", "subagents_list"] as const;

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function field(frontmatter: string, key: string): string | undefined {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim() : undefined;
}

function bool(v: string | undefined): boolean | undefined {
  return v == null ? undefined : v === "true";
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const spm = field(fm, "system-prompt");
  const sm = field(fm, "session-mode");
  return {
    name: field(fm, "name") ?? fallbackName,
    description: field(fm, "description"),
    model: field(fm, "model"),
    thinking: field(fm, "thinking"),
    tools: field(fm, "tools"),
    skills: field(fm, "skill") ?? field(fm, "skills"),
    denyTools: field(fm, "deny-tools"),
    spawning: bool(field(fm, "spawning")),
    autoExit: bool(field(fm, "auto-exit")),
    systemPromptMode: spm === "replace" || spm === "append" ? spm : undefined,
    sessionMode: sm === "standalone" || sm === "lineage-only" || sm === "fork" ? sm : undefined,
    cwd: field(fm, "cwd"),
    body: body || undefined,
    disableModelInvocation: field(fm, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

/** Project-local definitions override global ones with the same name. */
export function discoverAgentDefinitions(cwd = process.cwd()): ListedAgentDefinition[] {
  const out = new Map<string, ListedAgentDefinition>();
  const dirs: Array<[string, "global" | "project"]> = [
    [join(getAgentConfigDir(), "agents"), "global"],
    [join(cwd, ".pi", "agents"), "project"],
  ];
  for (const [dir, source] of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((e) => e.endsWith(".md"))) {
      const def = parseAgentDefinition(readFileSync(join(dir, f), "utf8"), f.replace(/\.md$/, ""));
      if (def) out.set(def.name, { ...def, source });
    }
  }
  return [...out.values()];
}

export function loadAgentDefinition(name: string, cwd = process.cwd()): AgentDefinition | null {
  for (const p of [join(cwd, ".pi", "agents", `${name}.md`), join(getAgentConfigDir(), "agents", `${name}.md`)]) {
    if (!existsSync(p)) continue;
    const def = parseAgentDefinition(readFileSync(p, "utf8"), name);
    if (def) return def;
  }
  return null;
}

/** `spawning: false` denies every spawning tool; `deny-tools` adds names on top. */
export function resolveDenyTools(def: AgentDefinition | null): string[] {
  const denied = new Set<string>();
  if (def?.spawning === false) for (const t of SPAWNING_TOOLS) denied.add(t);
  for (const t of (def?.denyTools ?? "").split(",").map((s) => s.trim()).filter(Boolean)) denied.add(t);
  return [...denied];
}

/**
 * Child working directory: explicit param (relative to the parent's cwd), else the
 * agent's `cwd:` (relative to the agent config dir), else the parent's cwd.
 */
export function resolveChildCwd(paramCwd: string | undefined, def: AgentDefinition | null, parentCwd: string): string {
  if (paramCwd) return paramCwd.startsWith("/") ? paramCwd : join(parentCwd, paramCwd);
  if (def?.cwd) return def.cwd.startsWith("/") ? def.cwd : join(getAgentConfigDir(), def.cwd);
  return parentCwd;
}

/**
 * Where pi would store sessions for `cwd` — the same encoding pi uses, so a child's
 * session shows up in `pi --session` listings for its project. Prefers a project-local
 * `.pi/agent` when one exists.
 */
export function resolveChildSessionDir(cwd: string): { sessionDir: string; agentDir: string } {
  const local = join(cwd, ".pi", "agent");
  const agentDir = existsSync(local) ? local : getAgentConfigDir();
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safe);
  mkdirSync(sessionDir, { recursive: true });
  return { sessionDir, agentDir };
}
