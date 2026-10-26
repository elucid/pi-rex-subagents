import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { resolveChildSessionDir } from "../src/agents.ts";

let root: string;
let agentDir: string;
let pooled: string;
let workspace: string;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "rex-session-dir-")));
  agentDir = join(root, "agent");
  pooled = join(agentDir, "sessions", "pooled");
  workspace = join(root, "ws");
  for (const d of ["ws/main", "ws/wt-a/apps", "ws-sibling", "elsewhere", "local/.pi/agent"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

const scoped = () => ({ PI_CODING_AGENT_SESSION_DIR: pooled, PI_SESSION_DIR_SCOPE: `${workspace}/` });
const perCwd = (cwd: string) => join(agentDir, "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);

test("without an override, uses pi's per-cwd folder", () => {
  const cwd = join(workspace, "wt-a");
  assert.equal(resolveChildSessionDir(cwd, {}).sessionDir, perCwd(cwd));
});

test("an unscoped override applies everywhere, as it does for pi", () => {
  const env = { PI_CODING_AGENT_SESSION_DIR: pooled };
  assert.equal(resolveChildSessionDir(join(root, "elsewhere"), env).sessionDir, pooled);
});

test("a scoped override applies to worktrees under the scope, nested ones too", () => {
  assert.equal(resolveChildSessionDir(join(workspace, "main"), scoped()).sessionDir, pooled);
  assert.equal(resolveChildSessionDir(join(workspace, "wt-a", "apps"), scoped()).sessionDir, pooled);
});

test("a scoped override does not apply to the scope root, a sibling prefix, or elsewhere", () => {
  for (const cwd of [workspace, join(root, "ws-sibling"), join(root, "elsewhere")]) {
    assert.equal(resolveChildSessionDir(cwd, scoped()).sessionDir, perCwd(cwd), cwd);
  }
});

test("a project-local .pi/agent still wins over the override", () => {
  const cwd = join(root, "local");
  const env = { PI_CODING_AGENT_SESSION_DIR: pooled };
  assert.equal(
    resolveChildSessionDir(cwd, env).sessionDir,
    join(cwd, ".pi", "agent", "sessions", `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`),
  );
});
