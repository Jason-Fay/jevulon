/**
 * Escalation ledger for the MCP shield: single-use, payload-bound human approvals with a TTL.
 * Every request records the identity that asked (`requestedBy`) and every decision the identity that
 * made it (`approvedBy`); the requesting identity is refused as decider.
 *
 * Extracted from `server.ts` so the approval semantics - fingerprint binding, the status machine,
 * expiry pruning - live in one reviewable unit with no transport, telemetry, or process concerns.
 */
import crypto from "node:crypto";
import type { ShieldEvaluation } from "../types.js";

export type EscalationStatus = "pending" | "approved" | "denied" | "consumed";

export interface EscalationRequest {
  actionId: string;
  /** SHA-256 over the canonical action payload; approval only ever applies to this exact payload. */
  fingerprint: string;
  commandOrTool: string;
  evaluation: ShieldEvaluation;
  /** Identity of the agent whose action triggered this escalation - the identity that must never decide it. */
  requestedBy: string;
  status: EscalationStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  /** Identity recorded on the decision (approve or deny); `UNATTRIBUTED_APPROVER` when the host attributes nothing. */
  approvedBy?: string;
  approvalId?: string;
}

export const DEFAULT_ESCALATION_TTL_MS = 15 * 60 * 1000;

/** Marker for a decision the host attributes to nobody; its security posture lives with the host. */
export const UNATTRIBUTED_APPROVER = "unattributed";

/** Raised when the identity that requested an escalation tries to decide it - a gate the gated controls is no gate. */
export class SelfApprovalError extends Error {
  constructor(
    public readonly actionId: string,
    public readonly identity: string
  ) {
    super(`Escalation "${actionId}": the gated agent cannot authorize itself (approvedBy === requestedBy === "${identity}").`);
    this.name = "SelfApprovalError";
  }
}

/** Raised when an approval arrives with no operator identity: approvals must be attributed. */
export class UnattributedApprovalError extends Error {
  constructor(actionId: string) {
    super(`Escalation "${actionId}": approval refused - pass approvedBy with the operator identity; unattributed approvals are not accepted.`);
    this.name = "UnattributedApprovalError";
  }
}

/** Sorted-key JSON so semantically identical payloads always produce the same fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Stable fingerprint of the exact action payload an approval is bound to. */
export function fingerprintOf(args: { commandOrTool: string; arguments?: unknown }): string {
  const payload = `${args.commandOrTool}\n${canonicalJson(args.arguments ?? null)}`;
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export class EscalationStore {
  private readonly requests = new Map<string, EscalationRequest>();

  constructor(private readonly ttlMs: number = DEFAULT_ESCALATION_TTL_MS) {}

  public create(args: {
    fingerprint: string;
    commandOrTool: string;
    evaluation: ShieldEvaluation;
    /** The calling agent identity - the identity the decision must never belong to. */
    requestedBy: string;
  }): EscalationRequest {
    const now = Date.now();
    const request: EscalationRequest = {
      actionId: `act_${crypto.randomBytes(8).toString("hex")}`,
      fingerprint: args.fingerprint,
      commandOrTool: args.commandOrTool,
      evaluation: args.evaluation,
      requestedBy: args.requestedBy,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.requests.set(request.actionId, request);
    return request;
  }

  public get(actionId: string): EscalationRequest | undefined {
    return this.requests.get(actionId);
  }

  /** First request matching both the payload fingerprint and the status. */
  public find(fingerprint: string, status: EscalationStatus): EscalationRequest | undefined {
    return [...this.requests.values()].find((request) => request.fingerprint === fingerprint && request.status === status);
  }

  /**
   * Records the operator decision and the identity that made it. Throws when the request is unknown,
   * expired, or already decided - a stale approval must never be silently re-interpreted - and when
   * the deciding identity is the one that asked: the gated agent cannot authorize itself.
   */
  public decide(actionId: string, approved: boolean, approvedBy?: string): EscalationRequest {
    const request = this.requests.get(actionId);
    // Expiry is enforced here, not just in prune(): a TTL-expired request is indistinguishable from
    // an unknown one, so an approval can never outlive its deadline.
    if (!request || request.expiresAt <= Date.now()) {
      throw new Error(`Escalation "${actionId}" not found (unknown or expired).`);
    }
    if (request.status !== "pending") {
      throw new Error(`Escalation "${actionId}" is already ${request.status}; request a fresh inspection instead.`);
    }
    if (approved && (approvedBy === undefined || approvedBy.trim() === "")) {
      // Fail closed: an approval with no operator identity is the gated agent approving itself with
      // extra steps (MCP-ESCALATION-SELFAPPROVE). Denials stay allowed - they are the safe direction.
      throw new UnattributedApprovalError(actionId);
    }
    const decider = approvedBy ?? UNATTRIBUTED_APPROVER;
    if (decider === request.requestedBy) {
      throw new SelfApprovalError(actionId, decider);
    }
    request.status = approved ? "approved" : "denied";
    request.approvedBy = decider;
    request.decidedAt = Date.now();
    if (approved) {
      request.approvalId = `apr_${crypto.randomBytes(8).toString("hex")}`;
    }
    return request;
  }

  /** Marks an authorization as used; single-use is enforced by callers' find-then-consume order. */
  public consume(request: EscalationRequest): void {
    request.status = "consumed";
  }

  /** Drops expired and consumed requests so long sessions cannot grow without bound. */
  public prune(now = Date.now()): void {
    for (const [actionId, request] of this.requests) {
      if (request.expiresAt <= now || request.status === "consumed") {
        this.requests.delete(actionId);
      }
    }
  }

  public counts(): { pending: number; approved: number; denied: number } {
    const all = [...this.requests.values()];
    return {
      pending: all.filter((request) => request.status === "pending").length,
      approved: all.filter((request) => request.status === "approved").length,
      denied: all.filter((request) => request.status === "denied").length,
    };
  }

  public list(): EscalationRequest[] {
    return [...this.requests.values()];
  }
}
