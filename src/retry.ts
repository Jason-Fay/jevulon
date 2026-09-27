/**
 * Transport retry policy for the JEV client.
 *
 * Extracted verbatim from `client.ts` — which failures are worth another attempt, and how long to wait, are
 * decisions that can be tested without a network.
 */
import { JevHttpError, JevUnavailableError } from "./errors.js";

/** Socket-level faults worth another attempt. */
const TRANSIENT_NETWORK_CODES: Record<string, true> = {
  ECONNRESET: true,
  ETIMEDOUT: true,
  ECONNREFUSED: true,
  EPIPE: true,
  ENOTFOUND: true,
};

/** Backoff saturates here so a high attempt number can never stall for minutes or overflow to Infinity. */
export const MAX_BACKOFF_MS = 30_000;

/**
 * True for failures that are worth another attempt: HTTP rate limiting and server faults, the
 * fallback-class JevUnavailableError, and socket-level transport faults (reset, timeout, DNS).
 * Programming errors — TypeError, RangeError, assertion failures — are deterministic, so retrying
 * them only burns the backoff budget: they fail immediately.
 */
export function isTransient(error: Error): boolean {
  if (error instanceof JevHttpError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  if (error instanceof JevUnavailableError) {
    return true;
  }
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === "string" && TRANSIENT_NETWORK_CODES[code] === true;
}

/** Exponential backoff with jitter, in milliseconds, saturating at `maxDelayMs`. */
export function backoffDelayMs(attempt: number, baseMs: number, maxDelayMs = MAX_BACKOFF_MS): number {
  return Math.min(baseMs * 2 ** attempt + Math.random() * baseMs, maxDelayMs);
}
