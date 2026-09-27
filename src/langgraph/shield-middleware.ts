import { SwarmShield } from "../shield.js";
import { TelemetryCollector } from "../telemetry.js";
import type { ProjectMemory } from "../memory.js";
import { parseCalibrationProfile } from "../profile.js";
import type { ShieldEvaluation } from "../types.js";

export class ShieldViolationError extends Error {
  constructor(public evaluation: ShieldEvaluation) {
    super(`JEVULON VII Shield blocked execution: ${evaluation.reason}`);
    this.name = "ShieldViolationError";
  }
}

/** Raised when the shield demands human confirmation and no approving hook is configured. */
export class ShieldEscalationError extends Error {
  constructor(public evaluation: ShieldEvaluation) {
    super(`JEVULON VII Shield requires human approval before execution: ${evaluation.reason}`);
    this.name = "ShieldEscalationError";
  }
}

export interface ShieldMiddlewareOptions {
  shield?: SwarmShield;
  telemetry?: TelemetryCollector;
  /** Client-side project memory: shield verdicts are counted into the usage file. */
  memory?: ProjectMemory;
  tenantId?: string;
  /**
   * Human-in-the-loop seam for `escalate_human` verdicts.
   * Return true to execute the tool despite the escalation. Defaults to deny (throws ShieldEscalationError).
   */
  onEscalate?: (evaluation: ShieldEvaluation, toolName: string) => Promise<boolean> | boolean;
}

/**
 * Tool & Action Interceptor for LangGraph agents.
 * Evaluates destructive probability and blast radius BEFORE any command or tool runs.
 * Blocks and unapproved escalations never execute; transport failures propagate (fail closed).
 */
export class SwarmShieldMiddleware {
  private shield: SwarmShield;
  private telemetry: TelemetryCollector;
  private memory?: ProjectMemory;
  private tenantId: string;
  private onEscalate?: (evaluation: ShieldEvaluation, toolName: string) => Promise<boolean> | boolean;
  private appliedProfileVersion = -1;

  constructor(options: ShieldMiddlewareOptions = {}) {
    this.shield = options.shield || new SwarmShield();
    this.telemetry = options.telemetry || new TelemetryCollector();
    this.memory = options.memory;
    this.tenantId = options.tenantId || "default_tenant";
    this.onEscalate = options.onEscalate;
  }

  /**
   * Wraps an asynchronous LangGraph tool function with pre-flight safety inspection.
   */
  public wrapTool<TArgs extends unknown[], TResult>(
    toolName: string,
    toolFn: (...args: TArgs) => Promise<TResult>
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      this.memory?.increment("shieldInspections");
      const rawProfile = this.memory?.getProfile();
      if (rawProfile) {
        const profile = parseCalibrationProfile(rawProfile);
        if (profile && profile.version !== this.appliedProfileVersion) {
          this.shield.applyProfile(profile);
          this.appliedProfileVersion = profile.version;
        }
      }

      const evaluation = await this.shield.inspectAction({
        commandOrTool: toolName,
        arguments: args.length === 1 ? args[0] : args,
      });

      if (evaluation.verdict === "block") {
        this.memory?.increment("shieldBlocks");
        this.telemetry.record(
          this.tenantId,
          {
            eventType: "shield_block",
            latencyMs: evaluation.latencyMs,
            confidence: evaluation.destructiveProbability,
            model: "jev-latest",
          },
          {
            tool: toolName,
            reason: evaluation.reason,
            riskScore: evaluation.riskScore,
          }
        );

        throw new ShieldViolationError(evaluation);
      }

      if (evaluation.verdict === "escalate_human") {
        this.memory?.increment("shieldEscalations");
        this.telemetry.record(
          this.tenantId,
          {
            eventType: "shield_escalation",
            latencyMs: evaluation.latencyMs,
            confidence: evaluation.destructiveProbability,
            model: "jev-latest",
          },
          {
            tool: toolName,
            reason: evaluation.reason,
            riskScore: evaluation.riskScore,
          }
        );

        const approved = this.onEscalate ? await this.onEscalate(evaluation, toolName) : false;
        if (!approved) {
          throw new ShieldEscalationError(evaluation);
        }
      }

      return await toolFn(...args);
    };
  }
}
