// Process-global count of subagents this pi is currently watching. Shared between
// the orchestrator extension and the child extension when both are loaded into one
// process (a subagent that is itself an orchestrator must not auto-exit while its
// own children are still running — their handoffs would have no live session to
// wake). A Symbol.for key survives /reload; a Set lets stale closures only remove
// their own ids.
const KEY = Symbol.for("pi-rex-subagents/active-subagent-ids");

function ids(): Set<string> {
  const g = globalThis as any;
  if (!(g[KEY] instanceof Set)) g[KEY] = new Set<string>();
  return g[KEY];
}

export const activeSubagentCount = (): number => ids().size;
export const markSubagentActive = (id: string): void => void ids().add(id);
export const markSubagentInactive = (id: string): void => void ids().delete(id);
