/**
 * Stigmergic pheromone fields (Exp 74): bounded, evaporating trails that bias dispatch.
 *
 * Extracted from `blackboard.ts`: the field is pure bookkeeping - deposits never go negative, the map
 * is capped (lowest-value entry evicted) so a hostile target space cannot exhaust memory, and decay
 * removes entries that fall below the trace threshold.
 */
export class PheromoneField {
  private readonly values = new Map<string, number>();

  constructor(private readonly maxEntries: number = 1000) {}

  public deposit(target: string, amount = 1.0): void {
    if (!target || typeof target !== "string") return;
    if (this.values.size >= this.maxEntries && !this.values.has(target)) {
      const [lowestKey] = Array.from(this.values.entries()).reduce((lowest, entry) => (entry[1] < lowest[1] ? entry : lowest));
      this.values.delete(lowestKey);
    }
    this.values.set(target, (this.values.get(target) || 0) + Math.max(0, amount));
  }

  public get(target: string): number {
    return this.values.get(target) || 0;
  }

  public get size(): number {
    return this.values.size;
  }

  public evaporate(decayRate = 0.1): void {
    for (const [key, value] of this.values) {
      const next = value * (1 - decayRate);
      if (next < 0.05) this.values.delete(key);
      else this.values.set(key, next);
    }
  }
}
