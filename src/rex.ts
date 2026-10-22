// Thin client over the `rex` CLI. Every call is `rex … --json` via execFile (argv
// array, no shell), so nothing here is ever shell-quoted.
//
// Only the handful of primitives the extension needs:
//   split   — create the child's block with an exact argv (no typing, no race)
//   wait    — block until the child's program exits; yields its exit code
//   capture — the block's screen (diagnostics after a failure)
//   close / rename / sendKey
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

export interface RexEnv {
  REX_SESSION?: string;
  REX_BLOCK?: string;
  REX_BIN_DIR?: string;
  REX_BIN?: string;
}

/** True when this process was started inside a Rex terminal. */
export function insideRex(env: RexEnv = process.env): boolean {
  return Boolean(env.REX_SESSION && env.REX_BLOCK);
}

/** The `rex` that matches the running server, falling back to PATH. */
export function resolveRexBin(env: RexEnv = process.env): string {
  if (env.REX_BIN) return env.REX_BIN;
  if (env.REX_BIN_DIR) return join(env.REX_BIN_DIR, "rex");
  return "rex";
}

export interface SplitParams {
  /** Block to split off (the orchestrator's own `$REX_BLOCK`). */
  anchor: string;
  direction?: "right" | "left" | "above" | "below";
  /** Percent of the split given to the new block. */
  ratio?: number;
  cwd: string;
  label: string;
  /** Exact argv for the block's program. Rex passes it to execve unchanged. */
  command: string[];
  /** Keep the block after the program exits (the parent closes it). Default true. */
  keepOpen?: boolean;
  focus?: boolean;
}

export type WaitResult =
  | { kind: "exited"; exitCode: number; error?: string }
  | { kind: "closed" } // block closed before its program reported an exit
  | { kind: "lost"; message: string }; // server gone / wait failed for another reason

/** One Program Status Protocol (OSC 7501) record, as reported by the block's program. */
export interface ProgramStatus {
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind?: "permission" | "question" | "auth";
  msg?: string;
  app?: string;
}

export interface RexClient {
  split(p: SplitParams): Promise<{ blockId: string }>;
  wait(blockId: string, signal?: AbortSignal): Promise<WaitResult>;
  capture(blockId: string): Promise<string | null>;
  close(blockId: string): Promise<void>;
  rename(blockId: string, label: string): Promise<void>;
  sendKey(blockId: string, key: string): Promise<void>;
  exists(blockId: string): Promise<boolean>;
  /** The program's root status record, or null if none / block gone. */
  programStatus(blockId: string): Promise<ProgramStatus | null>;
}

type Exec = (
  bin: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: Exec = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export function createRexClient(opts: { bin?: string; exec?: Exec } = {}): RexClient {
  const bin = opts.bin ?? resolveRexBin();
  const exec = opts.exec ?? defaultExec;

  async function json<T>(args: string[]): Promise<T> {
    const r = await exec(bin, args);
    if (r.code !== 0) {
      throw new Error(`rex ${args[0]} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      throw new Error(`rex ${args[0]}: unparseable JSON: ${r.stdout.slice(0, 200)}`);
    }
  }

  return {
    async split(p) {
      const args = [
        "split",
        "-b", p.anchor,
        "--split", p.direction ?? "right",
        "--ratio", String(p.ratio ?? 50),
        `--focus=${p.focus ?? false}`,
        "--shell", "none",
        "-c", p.cwd,
        "--label", p.label,
        "--json",
      ];
      if (p.keepOpen ?? true) args.push("--keep-open");
      args.push("--", ...p.command);
      const r = await json<{ block_ids?: string[] }>(args);
      const blockId = r.block_ids?.[0];
      if (!blockId) throw new Error("rex split returned no block id");
      return { blockId };
    },

    wait(blockId, signal) {
      // Long-running: `rex wait` holds until the child exits. stdout carries the
      // terminating payload as one JSON line; the exit status mirrors the child's.
      return new Promise((resolve) => {
        const child = spawn(bin, ["wait", blockId, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        const onAbort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (e) => resolve({ kind: "lost", message: e.message }));
        child.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);
          let payload: any = null;
          try {
            payload = JSON.parse(out.trim().split("\n").pop() ?? "");
          } catch {
            /* fall through */
          }
          if (payload && typeof payload.exit_code === "number") {
            resolve({ kind: "exited", exitCode: payload.exit_code, error: payload.error });
          } else if (payload && typeof payload.block_id === "string") {
            resolve({ kind: "closed" });
          } else {
            resolve({ kind: "lost", message: err.trim() || `rex wait exited ${code} without a payload` });
          }
        });
      });
    },

    async capture(blockId) {
      const r = await exec(bin, ["capture", "-b", blockId, "--trim"]);
      return r.code === 0 ? r.stdout : null;
    },

    async close(blockId) {
      await exec(bin, ["block", "close", blockId]);
    },

    async rename(blockId, label) {
      await exec(bin, ["block", "rename", blockId, label]);
    },

    async sendKey(blockId, key) {
      await exec(bin, ["send-key", "-b", blockId, key]);
    },

    async exists(blockId) {
      const r = await exec(bin, ["block", "inspect", blockId, "--json"]);
      return r.code === 0;
    },

    async programStatus(blockId) {
      const r = await exec(bin, ["block", "call", "-b", blockId, "program_status"]);
      if (r.code !== 0) return null;
      try {
        const records: any[] = JSON.parse(r.stdout).records ?? [];
        const root = records.find((x) => !x.id) ?? records[0];
        if (!root?.state) return null;
        return { state: root.state, kind: root.kind, msg: root.msg, app: root.app ?? root.effective_app };
      } catch {
        return null;
      }
    },
  };
}
