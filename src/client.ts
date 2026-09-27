import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  JevEvaluationResult,
  QuestionsMap,
  ChoiceQuestion,
  ScoreQuestion,
  NoulQuestion,
  JevAnswer,
  ShieldVerdict,
} from "./types.js";
import { JevHttpError, JevUnavailableError, MissingCredentialError } from "./errors.js";
import { classifySimulatedAction, flattenStateText } from "./offline-policy.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { backoffDelayMs, isTransient } from "./retry.js";

export type JevClientMode = "live" | "simulation";

export interface CircuitBreakerOptions {
  /** Consecutive failed evaluations before the breaker fast-fails (default 5). */
  failureThreshold?: number;
  /** How long the breaker stays open after tripping, in ms (default 30_000). */
  cooldownMs?: number;
}

export interface JevClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  /** Explicit evaluation mode. `live` requires a credential; `simulation` answers from the deterministic simulator. */
  mode?: JevClientMode;
  /** Legacy alias for `mode`: `true` => simulation, `false` => live. */
  simulation?: boolean;
  /** Retries for transient transport failures (default 5 => up to 6 attempts, clamped to 10). */
  retries?: number;
  /** Base backoff between retries, in ms (default 150; exponential with jitter). */
  retryBaseMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  /** Observability hook fired on every failed transport attempt. */
  onTransportError?: (error: Error, attempt: number) => void;
}

function clamp01(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

const DEFAULT_RETRIES = 5;
const MAX_RETRIES = 10;

/** Retries are bounded: default 5, cap 10 — enough resilience without unbounded retry storms. */
function clampRetries(requested: number | undefined): number {
  const value = requested ?? DEFAULT_RETRIES;
  return Number.isFinite(value) ? Math.min(MAX_RETRIES, Math.max(0, Math.floor(value))) : DEFAULT_RETRIES;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A 2xx body must answer every requested question with a shaped value. Empty or malformed payloads
 * are typed failures, never the silent `answers || {}` whose missing numbers read as the 0/0 the
 * shield would classify "allow".
 */
function parseEvaluationResponse(
  body: string,
  questions: QuestionsMap,
  latencyMs: number,
  fallbackModel: string
): JevEvaluationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new JevUnavailableError(`Failed to parse JEV response: ${err}`);
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.answers)) {
    throw new JevUnavailableError("JEV returned a 200 response without an answers object; failing closed.");
  }
  for (const [key, question] of Object.entries(questions)) {
    const answer: unknown = parsed.answers[key];
    if (!isPlainRecord(answer)) {
      throw new JevUnavailableError(`JEV returned no usable answer for "${key}"; failing closed.`);
    }
    if (question.type === "choice" && (typeof answer.choice !== "string" || answer.choice.length === 0)) {
      throw new JevUnavailableError(`JEV returned a malformed "${key}" choice answer; failing closed.`);
    }
    if (question.type === "score" && (typeof answer.score !== "number" || !Number.isFinite(answer.score))) {
      throw new JevUnavailableError(`JEV returned a malformed "${key}" score answer; failing closed.`);
    }
    if (question.type === "noul" && (typeof answer.noul !== "number" || !Number.isFinite(answer.noul))) {
      throw new JevUnavailableError(`JEV returned a malformed "${key}" noul answer; failing closed.`);
    }
  }
  return {
    answers: parsed.answers as Record<string, JevAnswer>,
    usage: parsed.usage as JevEvaluationResult["usage"],
    latencyMs,
    model: typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : fallbackModel,
  };
}

export class JevClient {
  private apiKey: string;
  private endpoint: string;
  private defaultModel: string;
  private defaultTimeoutMs: number;
  private agent: https.Agent;
  private retries: number;
  private retryBaseMs: number;
  private failureThreshold: number;
  private cooldownMs: number;
  private onTransportError?: (error: Error, attempt: number) => void;
  private readonly circuit: CircuitBreaker;
  public readonly mode: JevClientMode;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey || JevClient.resolveApiKey();
    this.endpoint =
      options.endpoint ||
      process.env.TYPESAFE_BASE_URL ||
      process.env.JEV_ENDPOINT ||
      "https://drex.nace.ai/v1/systemone";
    this.defaultModel =
      options.model ||
      process.env.TYPESAFE_DEFAULT_MODEL ||
      process.env.JEV_MODEL ||
      "drex-latest";
    this.defaultTimeoutMs = options.timeoutMs || 15000;
    this.retries = clampRetries(options.retries);
    this.retryBaseMs = options.retryBaseMs ?? 150;
    this.failureThreshold = options.circuitBreaker?.failureThreshold ?? 5;
    this.cooldownMs = options.circuitBreaker?.cooldownMs ?? 30_000;
    this.circuit = new CircuitBreaker(this.failureThreshold, this.cooldownMs);
    this.onTransportError = options.onTransportError;

    const requested: JevClientMode | undefined =
      options.mode ?? (options.simulation === undefined ? undefined : options.simulation ? "simulation" : "live");
    if (requested === "simulation") {
      this.mode = "simulation";
    } else {
      // Live evaluation requires a credential: never fabricate safety verdicts from a missing key.
      if (!this.hasCredential()) throw new MissingCredentialError();
      this.mode = "live";
    }

    // Persistent TLS keep-alive for sub-300ms round trips
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 32,
      keepAliveMsecs: 60000,
    });
  }

  /** True when this client answers from the deterministic simulator instead of the JEV endpoint. */
  public get simulation(): boolean {
    return this.mode === "simulation";
  }

  /** Model identifier used for live evaluations (telemetry labels it on every recorded event). */
  public get modelName(): string {
    return this.defaultModel;
  }

  public static resolveApiKey(): string {
    if (process.env.NACEDM_API_KEY) return process.env.NACEDM_API_KEY;
    if (process.env.DREX_API_KEY) return process.env.DREX_API_KEY;
    if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
    if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;

    // Check ~/.omp/.env
    try {
      const ompEnv = path.join(os.homedir(), ".omp", ".env");
      if (fs.existsSync(ompEnv)) {
        const content = fs.readFileSync(ompEnv, "utf-8");
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("NACEDM_API_KEY=")) return trimmed.slice(15).trim();
          if (trimmed.startsWith("DREX_API_KEY=")) return trimmed.slice(13).trim();
          if (trimmed.startsWith("TYPESAFE_API_KEY=")) return trimmed.slice(17).trim();
          if (trimmed.startsWith("JEV_API_KEY=")) return trimmed.slice(12).trim();
        }
      }
    } catch {
      // Ignore
    }
    return "";
  }

  public hasCredential(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 0);
  }

  public async evaluate(
    state: unknown,
    questions: QuestionsMap,
    options?: { timeoutMs?: number; model?: string }
  ): Promise<JevEvaluationResult> {
    if (this.mode === "simulation") {
      return this.simulateEvaluation(state, questions);
    }

    if (this.circuit.isOpen) {
      throw new JevUnavailableError(
        `JEV circuit breaker is open for another ${Math.ceil(this.circuit.remainingCooldownMs / 1000)}s after ${this.failureThreshold} consecutive failures.`
      );
    }

    const payload = JSON.stringify({
      model: options?.model || this.defaultModel,
      state: typeof state === "string" ? state : JSON.stringify(state ?? null),
      questions,
    });

    const payloadBytes = Buffer.byteLength(payload);
    if (payloadBytes > 512 * 1024) {
      // Fallback-class on purpose: an oversized state degrades callers to their deterministic
      // fallback instead of crashing them on a plain Error.
      throw new JevUnavailableError(`State payload exceeds maximum size (${payloadBytes} > ${512 * 1024} bytes)`);
    }

    let lastError: Error = new JevUnavailableError("JEV request failed without an error");
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const result = await this.attemptRequest(payload, questions, options);
        this.circuit.recordSuccess();
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;
        try {
          this.onTransportError?.(error, attempt + 1);
        } catch {
          // Observability hooks must never mask the classified transport failure.
        }
        if (!isTransient(error) || attempt === this.retries) break;
        const backoffMs = backoffDelayMs(attempt, this.retryBaseMs);
        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    this.circuit.recordFailure();
    throw new JevUnavailableError(`JEV evaluation failed after ${this.retries + 1} attempt(s): ${lastError.message}`, {
      cause: lastError,
    });
  }

  /** Issues one HTTP request; resolves with the parsed evaluation or rejects with a classified error. */
  private attemptRequest(payload: string, questions: QuestionsMap, options?: { timeoutMs?: number }): Promise<JevEvaluationResult> {
    const url = new URL(this.endpoint);
    const start = Date.now();
    return new Promise<JevEvaluationResult>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          agent: this.agent,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
          timeout: options?.timeoutMs || this.defaultTimeoutMs,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            const latencyMs = Date.now() - start;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(parseEvaluationResponse(body, questions, latencyMs, this.defaultModel));
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            } else {
              reject(new JevHttpError(res.statusCode ?? 0, body));
            }
          });
        },
      );

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        // Coded like a socket timeout so the retry policy keeps classifying it as a transport fault.
        reject(
          Object.assign(new Error(`JEV request timed out after ${options?.timeoutMs || this.defaultTimeoutMs}ms`), {
            code: "ETIMEDOUT",
          }),
        );
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Deterministic simulation mode for zero-key developer onboarding and testing.
   * Mirrors the documented closed-world behaviors (destruction, obfuscation, exfiltration,
   * ambiguous repo-clean, runaway loops) so keyless demos and the test suite stay meaningful.
   */
  private simulateEvaluation(state: unknown, questions: QuestionsMap): JevEvaluationResult {
    const stateText = flattenStateText(state);
    const risk = classifySimulatedAction(stateText);
    const answers: Record<string, JevAnswer> = {};

    for (const [key, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const choices = Object.keys(q.criteria);
        const interventionMenu =
          choices.includes("continue") && choices.some((c) => /quarantine|halt|reroute/.test(c));
        let picked: string | undefined;
        if (interventionMenu && this.looksStuck(stateText)) {
          picked = choices.find((c) => c.includes("quarantine")) ?? choices.find((c) => c !== "continue");
        }
        picked ??= choices.find((c) => c.includes("recover") || c.includes("assign")) ?? choices[0] ?? "default";
        answers[key] = {
          choice: picked,
          confidence: 0.88,
          probabilities: Object.fromEntries(choices.map((c) => [c, c === picked ? 0.88 : 0.12 / (choices.length - 1 || 1)])),
        };
      } else if (q.type === "noul") {
        const isDestructiveCheck = /destructive|hostile|violate/i.test(q.instructions);
        const noulVal = isDestructiveCheck ? (risk.destructive ? 0.95 : risk.ambiguous ? 0.45 : 0.05) : 0.92;
        answers[key] = {
          noul: noulVal,
          confidence: noulVal >= 0.5 ? noulVal : 1 - noulVal,
        };
      } else if (q.type === "score") {
        answers[key] = {
          score: risk.destructive ? 4.0 : risk.ambiguous ? 2.6 : 1.0,
          confidence: 0.9,
        };
      }
    }

    return {
      answers,
      latencyMs: 15,
      model: "jev-simulation",
    };
  }

  /** Detects repeated identical failures so the simulated oversight reflex matches the live one. */
  private looksStuck(stateStr: string): boolean {
    const attempts = [...stateStr.matchAll(/attempt\s*#?\s*(\d+)/gi)].map((m) => Number(m[1]));
    if (attempts.some((n) => n >= 3)) return true;
    const failures = (stateStr.match(/ConnectionRefused|ECONNREFUSED|timed out|timeout|failed/gi) ?? []).length;
    return failures >= 4;
  }

  public async choice(
    state: unknown,
    instructions: string,
    criteria: Record<string, string>,
    options?: { timeoutMs?: number }
  ): Promise<{ choice: string; confidence: number; probabilities?: Record<string, number>; latencyMs: number }> {
    const result = await this.evaluate(
      state,
      {
        q: { type: "choice", instructions, criteria } as ChoiceQuestion,
      },
      options
    );
    const ans = result.answers.q || {};
    return {
      choice: typeof ans.choice === "string" ? ans.choice : "",
      confidence: clamp01(ans.confidence),
      probabilities: ans.probabilities,
      latencyMs: result.latencyMs,
    };
  }

  public async noul(
    state: unknown,
    instructions: string,
    options?: { timeoutMs?: number }
  ): Promise<{ noul: number; confidence: number; latencyMs: number }> {
    const result = await this.evaluate(
      state,
      {
        q: { type: "noul", instructions } as NoulQuestion,
      },
      options
    );
    const ans = result.answers.q || {};
    return {
      noul: clamp01(ans.noul),
      confidence: clamp01(ans.confidence),
      latencyMs: result.latencyMs,
    };
  }

  public async score(
    state: unknown,
    instructions: string,
    criteria: string[],
    options?: { timeoutMs?: number }
  ): Promise<{ score: number; confidence: number; probabilities?: Record<string, number>; latencyMs: number }> {
    const result = await this.evaluate(
      state,
      {
        q: { type: "score", instructions, criteria } as ScoreQuestion,
      },
      options
    );
    const ans = result.answers.q || {};
    return {
      score: typeof ans.score === "number" && Number.isFinite(ans.score) ? ans.score : 0,
      confidence: clamp01(ans.confidence),
      probabilities: ans.probabilities,
      latencyMs: result.latencyMs,
    };
  }
}
