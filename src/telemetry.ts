import crypto from "node:crypto";

export interface TelemetryConfig {
  enabled: boolean;
  byok: boolean; // Bring Your Own Key mode (zero-margin inference tracking)
  zeroRetention: boolean; // Enterprise toggle: evaluate in RAM, no disk storage
  /** Base salt for keyed hashing. Defaults to `SWARM_SENTINEL_TELEMETRY_SALT`, else random per process. */
  salt?: string;
  /** Ring-buffer cap for unsent events (default 1000). Oldest events are dropped first. */
  maxBufferedEvents?: number;
  /** Transport invoked by `flush()`. Without one, flush only drains the buffer to the caller. */
  sink?: (events: TelemetryEvent[]) => Promise<void> | void;
  /** Clock for event timestamps and the daily salt rotation. Defaults to wall time. */
  clock?: () => Date;
}

export interface TelemetryEvent {
  timestamp: number;
  tenantHash: string;
  eventType:
    | "routing_decision"
    | "worker_death"
    | "recovery_dispatch"
    | "oversight_quarantine"
    | "shield_block"
    | "shield_escalation"
    | "dispatch_degraded"
    | "completion_gate";
  latencyMs: number;
  confidence: number;
  model: string;
  /** True when the run used the customer's own TypeSafe credits (zero-margin inference). */
  byok: boolean;
  sanitizedMetadata: Record<string, unknown>;
}

interface ResolvedTelemetryConfig {
  enabled: boolean;
  byok: boolean;
  zeroRetention: boolean;
  maxBufferedEvents: number;
  sink?: (events: TelemetryEvent[]) => Promise<void> | void;
  clock: () => Date;
}

/** Applied in order: private keys and provider-specific tokens first, then generic patterns. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[SCRUBBED_PRIVATE_KEY]"],
  // API keys (OpenAI/Anthropic/Stripe-style, TypeSafe, GitHub, Slack, AWS, Google)
  // Lookbehind keeps slugs like `task-runner-…` (word-internal "sk-") from reading as API keys.
  [/(?<![A-Za-z0-9])sk-[a-zA-Z0-9_-]{20,}/g, "[SCRUBBED_API_KEY]"],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, "[SCRUBBED_GITHUB_TOKEN]"],
  [/github_pat_[A-Za-z0-9_]{22,}/g, "[SCRUBBED_GITHUB_TOKEN]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[SCRUBBED_SLACK_TOKEN]"],
  [/AKIA[0-9A-Z]{16}/g, "[SCRUBBED_AWS_KEY_ID]"],
  [/AIza[0-9A-Za-z_-]{35}/g, "[SCRUBBED_GOOGLE_KEY]"],
  [/\bBearer\s+[a-zA-Z0-9_\-.]{20,}/gi, "Bearer [SCRUBBED_TOKEN]"],
  [/TYPESAFE_[A-Z0-9_]+\s*=\s*[^\s]+/gi, "TYPESAFE_KEY=[SCRUBBED]"],
  [/JEV_[A-Z0-9_]+\s*=\s*[^\s]+/gi, "JEV_KEY=[SCRUBBED]"],
  // Database connection strings (bounded to the userinfo@host form, so bare URLs never scrub).
  // The scheme list is explicit: `postgresql://` and `mongodb+srv://` leaked the userinfo and host
  // through the narrower list (only the password fell through the email pattern).
  [/(postgresql|postgres|mongodb\+srv|mongodb|mysql|redis):\/\/[^\s@]+@[^\s]+/gi, "$1://[SCRUBBED_DB_URI]"],
  // Generic JWTs (header.payload.signature)
  [/eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "[SCRUBBED_JWT]"],
  // Email addresses
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[SCRUBBED_EMAIL]"],
  // IPv4 addresses
  [/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, "[SCRUBBED_IP]"],
];

/** Applies the secret/PII pattern set to any string (shared by telemetry, memory, and sync payloads). */
export function scrubSecrets(text: string): string {
  if (!text || typeof text !== "string") return "";
  let scrubbed = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

export class TelemetryCollector {
  private config: ResolvedTelemetryConfig;
  private baseSalt: string;
  private buffer: TelemetryEvent[] = [];
  private droppedCount = 0;

  /** False when no salt was provided, meaning tenant hashes differ between processes. */
  public readonly saltStable: boolean;

  constructor(config: Partial<TelemetryConfig> = {}) {
    const providedSalt = config.salt || process.env.SWARM_SENTINEL_TELEMETRY_SALT;
    this.saltStable = Boolean(providedSalt);
    this.baseSalt = providedSalt || crypto.randomBytes(16).toString("hex");
    this.config = {
      enabled: config.enabled ?? true,
      byok: config.byok ?? false,
      zeroRetention: config.zeroRetention ?? false,
      maxBufferedEvents: config.maxBufferedEvents ?? 1000,
      sink: config.sink,
      clock: config.clock ?? (() => new Date()),
    };
  }

  /**
   * PII and Secret Scrubber Gate.
   * Strips private keys, API keys, tokens, JWTs, connection strings, emails, and IPs.
   */
  public scrub(text: string): string {
    return scrubSecrets(text);
  }

  /**
   * Keyed Hash Anonymizer Gate.
   * Rotates the salt daily (HMAC(baseSalt, UTC date)) so identifiers cannot be correlated across
   * days, while staying stable across processes for the same day when a base salt is supplied.
   */
  public anonymize(identifier: string): string {
    const day = this.config.clock().toISOString().slice(0, 10);
    const dailyKey = crypto.createHmac("sha256", this.baseSalt).update(day).digest();
    return crypto.createHmac("sha256", dailyKey).update(identifier).digest("hex").slice(0, 16);
  }

  /**
   * Records a telemetry event if enabled and zero-retention is false.
   * Metadata is scrubbed recursively; the buffer is ring-bounded by `maxBufferedEvents`.
   */
  public record(
    tenantId: string,
    event: Omit<TelemetryEvent, "timestamp" | "tenantHash" | "sanitizedMetadata" | "byok">,
    metadata: Record<string, unknown> = {}
  ): TelemetryEvent | null {
    if (!this.config.enabled || this.config.zeroRetention) {
      return null;
    }

    const sanitizedMetadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      sanitizedMetadata[key] = this.scrubValue(value);
    }

    const record: TelemetryEvent = {
      timestamp: this.config.clock().getTime(),
      tenantHash: this.anonymize(tenantId),
      eventType: event.eventType,
      latencyMs: event.latencyMs,
      confidence: event.confidence,
      model: event.model,
      byok: this.config.byok,
      sanitizedMetadata,
    };

    this.buffer.push(record);
    if (this.buffer.length > this.config.maxBufferedEvents) {
      const overflow = this.buffer.length - this.config.maxBufferedEvents;
      this.buffer.splice(0, overflow);
      this.droppedCount += overflow;
    }
    return record;
  }

  /** Scrubs every string at any depth; arrays and objects are copied, never mutated. */
  private scrubValue(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.scrub(value);
    if (depth >= 6) return "[SCRUB_DEPTH_LIMIT]";
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => this.scrubValue(item, depth + 1));
    }
    if (value !== null && typeof value === "object") {
      const scrubbed: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        scrubbed[key] = this.scrubValue(item, depth + 1);
      }
      return scrubbed;
    }
    return value;
  }

  public getBufferedEvents(): TelemetryEvent[] {
    return [...this.buffer];
  }

  /** Events evicted from the ring buffer before ever being flushed. */
  public getDroppedEventCount(): number {
    return this.droppedCount;
  }

  /**
   * Drains the buffer and, when a sink is configured, hands the batch to it.
   * A failing sink is reported and the batch is requeued (bounded) rather than silently lost.
   */
  public async flush(): Promise<TelemetryEvent[]> {
    const events = this.buffer;
    this.buffer = [];
    if (this.config.sink && events.length > 0) {
      try {
        await this.config.sink(events);
      } catch (err) {
        this.buffer = [...events, ...this.buffer];
        if (this.buffer.length > this.config.maxBufferedEvents) {
          const overflow = this.buffer.length - this.config.maxBufferedEvents;
          this.buffer.splice(0, overflow);
          this.droppedCount += overflow;
        }
        throw err;
      }
    }
    return events;
  }
}
