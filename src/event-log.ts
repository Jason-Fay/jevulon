/**
 * Bounded event log: the blackboard's append-only history with a ring cap.
 *
 * Extracted from `blackboard.ts` so the retention policy (what a long run keeps, and what it drops)
 * is one testable unit instead of an implicit side effect of `logEvent`.
 */
import type { BlackboardEvent } from "./types.js";

export class EventLog {
  private readonly events: BlackboardEvent[] = [];

  constructor(private readonly maxEvents: number = 1000) {}

  /** Appends an event, timestamped now, dropping the oldest entries past the cap. */
  public log(event: Omit<BlackboardEvent, "timestamp">): void {
    this.events.push({ ...event, timestamp: Date.now() });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** The most recent `count` events (fewer when the log is shorter). */
  public recent(count: number): BlackboardEvent[] {
    return this.events.slice(-count);
  }

  /** Number of events currently retained (bounded by the cap). */
  public size(): number {
    return this.events.length;
  }
}
