/**
 * Typed error surface for Swarm Sentinel.
 * Safety-critical paths fail closed with an explicit, catchable error — never silently.
 */

export class MissingCredentialError extends Error {
  constructor(
    message = 'No TypeSafe/JEV credential found. Set TYPESAFE_API_KEY or JEV_API_KEY, or construct JevClient with { mode: "simulation" }.'
  ) {
    super(message);
    this.name = "MissingCredentialError";
  }
}

/** Raised when a sampled JEV answer is outside the menu that produced it. */
export class InvalidJevAnswerError extends Error {
  constructor(
    public context: string,
    public answer: string,
    public allowed: readonly string[]
  ) {
    super(`JEV returned out-of-vocabulary answer "${answer}" for ${context}; allowed: [${allowed.join(", ")}]`);
    this.name = "InvalidJevAnswerError";
  }
}

/** Raised when the JEV endpoint cannot be reached (after retries / while the circuit breaker is open). */
export class JevUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JevUnavailableError";
  }
}

/** Non-2xx HTTP response from the JEV endpoint. */
export class JevHttpError extends Error {
  constructor(
    public statusCode: number,
    body: string
  ) {
    super(`JEV request failed with HTTP ${statusCode}: ${body.slice(0, 300)}`);
    this.name = "JevHttpError";
  }
}

/** Raised when a replay artifact fails validation or integrity checking. */
export class RunArtifactIntegrityError extends Error {
  constructor(
    message: string,
    public expected?: string,
    public actual?: string
  ) {
    super(message);
    this.name = "RunArtifactIntegrityError";
  }
}

/** Validates a sampled JEV choice against the menu keys that produced it. */
export function validateChoice<T extends string>(answer: string, allowed: readonly T[], context: string): T {
  if (!allowed.includes(answer as T)) {
    throw new InvalidJevAnswerError(context, answer, allowed);
  }
  return answer as T;
}
