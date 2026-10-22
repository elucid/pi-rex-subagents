// End-to-end driver: spawn ONE real child pi in a Rex block beside this one and
// report how its lifecycle was classified. Run from inside a Rex terminal:
//
//   node test/e2e-child.ts done        # child must call subagent_done(summary)
//   node test/e2e-child.ts auto        # auto-exit child, no explicit handoff
//   node test/e2e-child.ts ping        # child must call caller_ping
//   node test/e2e-child.ts stay        # autoExit=false; you /quit it by hand
//   node test/e2e-child.ts badmodel    # launch failure: block must stay open
//
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRexClient, insideRex } from "../src/rex.ts";
import { planChild, startChild, writeTaskArtifact } from "../src/spawn.ts";
import { watchChild } from "../src/watcher.ts";

if (!insideRex()) {
  console.error("run this inside a Rex terminal");
  process.exit(2);
}

const scenario = process.argv[2] ?? "done";
const cwd = process.argv[3] ?? process.env.HOME!;
const sessionDir = mkdtempSync(join(tmpdir(), "pi-rex-e2e-"));
const artifactDir = join(sessionDir, "artifacts");

const tasks: Record<string, { task: string; autoExit: boolean; model?: string }> = {
  done: {
    autoExit: true,
    task:
      "Run `echo hello-from-child` with bash, then call subagent_done with a summary that " +
      "contains the exact phrase HANDOFF-OK and the command's output. Do not write anything else.",
  },
  auto: {
    autoExit: true,
    task: "Reply with exactly the text AUTO-EXIT-OK and nothing else. Do not call any tools.",
  },
  ping: {
    autoExit: true,
    task: "Call caller_ping with the message PING-OK immediately. Do not do anything else.",
  },
  stay: {
    autoExit: false,
    task: "Reply with the text STAY-OPEN-OK. Then wait; the user will quit this session by hand.",
  },
  badmodel: { autoExit: true, task: "irrelevant", model: "nonexistent/not-a-model" },
};

const t = tasks[scenario];
if (!t) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}

const rex = createRexClient();
const plan = planChild({
  name: `e2e-${scenario}`,
  cwd,
  sessionDir,
  autoExit: t.autoExit,
  model: t.model,
  prompt: writeTaskArtifact(artifactDir, `e2e-${scenario}`, t.task),
});

console.log("session file:", plan.sessionFile);
console.log("argv:", JSON.stringify(plan.command));

const started = Date.now();
const { blockId } = await startChild(rex, plan, {
  anchor: process.env.REX_BLOCK!,
  cwd,
  label: `e2e-${scenario}`,
  ratio: 40,
});
console.log("block:", blockId);

const outcome = await watchChild(rex, { blockId, sessionFile: plan.sessionFile });
console.log(`\nelapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("block still exists:", await rex.exists(blockId));
console.log("outcome:", JSON.stringify(outcome, null, 2));
