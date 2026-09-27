/**
 * Circuit breaker for the JEV transport.
 *
 * Extracted from `client.ts`: opening a circuit after consecutive transport failures is policy, and it
 * deserves its own unit tests rather than being observable only through a live endpoint.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    public readonly failureThreshold: number,
    public readonly cooldownMs: number,
    /** Clock seam: tests drive the cooldown window without sleeping (default: the wall clock). */
    private readonly now: () => number = Date.now
  ) {}

  /** Milliseconds until the circuit closes again; 0 when it is closed. */
  public get remainingCooldownMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  public get isOpen(): boolean {
    return this.remainingCooldownMs > 0;
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /**
   * Counts one failed evaluation (after retries are exhausted, not per attempt). Opening the circuit
   * resets the counter, so the next window starts fresh.
   */
  public recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
      this.consecutiveFailures = 0;
    }
  }
}
