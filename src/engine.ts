/**
 * The decision-engine seam: anything that can answer a typed menu choice and a 0..1 likelihood.
 * `JevClient` satisfies this interface structurally, so it remains the default engine; custom
 * engines (local heuristics, a hosted gateway, a different vendor) can be supplied without
 * touching the coordinator.
 */
export interface DecisionEngine {
  choice(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
    options?: { timeoutMs?: number }
  ): Promise<{ choice: string; confidence: number; probabilities?: Record<string, number>; latencyMs: number }>;

  noul(
    state: unknown,
    instructions: string,
    options?: { timeoutMs?: number }
  ): Promise<{ noul: number; confidence: number; latencyMs: number }>;
}
