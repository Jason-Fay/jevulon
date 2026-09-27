import crypto from "node:crypto";
import { Blackboard } from "../blackboard.js";
import { SwarmCoordinator } from "../coordinator.js";
import type { CircuitClassification, ReplayStep } from "../coordinator.js";
import { TelemetryCollector } from "../telemetry.js";
import type { ProjectMemory } from "../memory.js";
import { classifyOfflinePolicy } from "../offline-policy.js";
import { parseCalibrationProfile } from "../profile.js";
import type { CalibrationProfile, ProfileApplication } from "../profile.js";
import { buildRunArtifact } from "../artifact.js";
import type { RunArtifact } from "../artifact.js";
import type { DispatchDecision, Job, JobStatus, OversightVerdict } from "../types.js";

export interface SwarmSupervisorOptions {
  board?: Blackboard;
  coordinator?: SwarmCoordinator;
  telemetry?: TelemetryCollector;
  /** Client-side project memory: usage counters and bounded decision history persisted per project. */
  memory?: ProjectMemory;
  tenantId?: string;
  workers: Array<{ id: string; name: string }>;
  /** Opt-in heartbeat watchdog: workers silent longer than this are marked dead at turn start. */
  heartbeatTimeoutMs?: number;
}

export interface SupervisorState {
  currentJobId?: string;
  assignedWorkerId?: string;
  lastError?: string;
  /** No pending/wounded/running work remains. Failed jobs are reported via `escalated`/`failedJobIds`. */
  isComplete: boolean;
  /** Work remains but no idle worker can take it: deterministic policy escalation (Exp 84). */
  requiresHuman: boolean;
  /** At least one job tripped the anti-thrashing breaker and will not be retried. */
  escalated: boolean;
  failedJobIds: string[];
  /** True when this turn's dispatch ran on a deterministic fallback instead of a live JEV answer. */
  degraded: boolean;
  /** Why the fallback happened: "invalid_answer" (out-of-vocabulary) or "transport" (endpoint down). */
  fallbackReason?: "invalid_answer" | "transport";
  recoveryCount: number;
  wave: number;
  /** An oversight halt is in effect; nothing is dispatched until resume(). */
  halted: boolean;
  haltReason?: string;
  /** True when the loop should stop: complete, halted, or waiting on a human decision. */
  isTerminal: boolean;
}

/**
 * Pre-validated evidence envelope (deferred dogfooding finding #2): JSON text riding the existing
 * `evidence` string field — `{ kind: "token", issuedBy, scope, digest, summary }`, where `digest` is
 * the issuer's sha256 over the claimed `summary`. A wire shape only: nothing about it is exported
 * and no server/validate surface changes with it.
 */
interface EvidenceToken {
  issuedBy: string;
  scope: string;
  summary: string;
}

/**
 * Parses and authenticates an evidence envelope. Advisory-strict: anything that is not a well-formed
 * token whose digest binds the claimed summary yields `undefined`, leaving the evidence to the
 * calibrated gate exactly as a plain string report — never weaker.
 */
function parseEvidenceToken(evidence: string): EvidenceToken | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (!("kind" in parsed) || parsed.kind !== "token") return undefined;
  const issuedBy = "issuedBy" in parsed ? parsed.issuedBy : undefined;
  const scope = "scope" in parsed ? parsed.scope : undefined;
  const digest = "digest" in parsed ? parsed.digest : undefined;
  const summary = "summary" in parsed ? parsed.summary : undefined;
  if (typeof issuedBy !== "string" || issuedBy.length === 0 || issuedBy.length > 256) return undefined;
  if (typeof scope !== "string" || scope.length === 0) return undefined;
  if (typeof digest !== "string" || digest.length === 0) return undefined;
  if (typeof summary !== "string") return undefined;
  const bound = crypto.createHash("sha256").update(summary, "utf-8").digest("hex");
  if (digest.toLowerCase() !== bound) return undefined;
  return { issuedBy, scope, summary };
}

/**
 * Native LangGraph Supervisor Node with Autonomous Worker-Death Recovery (Exp 83 / Exp 84).
 *
 * Host loop contract:
 * ```ts
 * let state: Partial<SupervisorState> = {};
 * while (true) {
 *   state = await supervisor.supervise(state);
 *   if (state.halted) throw new Error(`halted: ${state.lastError}`);
 *   if (state.requiresHuman) await escalateToHuman(state.lastError);
 *   if (state.isComplete) break;               // check state.escalated / state.failedJobIds
 * }
 * ```
 * `state.isTerminal` is the one-line alternative (`isComplete || halted || requiresHuman`).
 */
export class SwarmSupervisor {
  private board: Blackboard;
  private coordinator: SwarmCoordinator;
  private telemetry: TelemetryCollector;
  private memory?: ProjectMemory;
  private tenantId: string;
  private heartbeatTimeoutMs?: number;
  private halted = false;
  private haltReason?: string;
  private appliedProfileVersion = -1;
  private runScript: ReplayStep[] = [];

  constructor(options: SwarmSupervisorOptions) {
    this.board = options.board || new Blackboard();
    this.coordinator = options.coordinator || new SwarmCoordinator();
    this.telemetry = options.telemetry || new TelemetryCollector();
    this.memory = options.memory;
    this.tenantId = options.tenantId || "default_tenant";
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;

    for (const w of options.workers) {
      this.board.registerWorker(w.id, w.name);
    }
  }

  public registerJob(job: Omit<Job, "attempts">): void {
    this.board.addJob(job);
  }

  /**
   * The supervisor node execution handler.
   * Each call advances one wave: sweep stale heartbeats, reconcile orphans, plan, dispatch.
   */
  public async supervise(state: Partial<SupervisorState> = {}): Promise<SupervisorState> {
    const recoveryCount = state.recoveryCount || 0;

    if (this.halted) {
      return this.buildHaltedState(recoveryCount);
    }

    const wave = await this.performTurnMaintenance();
    const decision = await this.coordinator.planNextAction(this.board);
    const recorded = decision ? this.coordinator.getDecisionLog().at(-1) : undefined;
    if (recorded) {
      this.runScript.push({ kind: "decision", entry: recorded });
      this.memory?.recordDecision(recorded);
      this.memory?.increment("decisions");
    }

    const snapshot = this.board.getSnapshot();
    const escalatedJobs = snapshot.jobs.filter((j) => j.status === "escalated");
    const base: SupervisorState = {
      isComplete: false,
      requiresHuman: false,
      escalated: escalatedJobs.length > 0,
      failedJobIds: escalatedJobs.map((j) => j.id),
      degraded: false,
      recoveryCount,
      wave,
      halted: false,
      isTerminal: false,
    };

    if (!decision) {
      return this.handleNoDecision(base, escalatedJobs);
    }

    if (decision.action === "policy_escalate_human") {
      return this.handlePolicyEscalation(base);
    }

    if (!decision.jobId || !decision.workerId) {
      return { ...base, lastError: `Unresolved dispatch decision: ${decision.action}` };
    }

    return this.handleSuccessfulDispatch(base, decision, recoveryCount);
  }

  private buildHaltedState(recoveryCount: number): SupervisorState {
    return {
      isComplete: false,
      requiresHuman: false,
      escalated: false,
      failedJobIds: [],
      degraded: false,
      recoveryCount,
      wave: this.board.getSnapshot().activeWave,
      halted: true,
      haltReason: this.haltReason,
      isTerminal: true,
      lastError: this.haltReason,
    };
  }

  private async performTurnMaintenance(): Promise<number> {
    const wave = this.board.nextWave();
    await this.memory?.autoSyncFromEnv().catch(() => null);
    this.appliedProfileVersion = SwarmSupervisor.applyProfileOnce(
      this.memory?.getProfile(),
      this.appliedProfileVersion,
      this.coordinator
    );
    this.memory?.increment("turns");
    if (this.heartbeatTimeoutMs !== undefined) {
      await this.board.sweepDeadWorkers(this.heartbeatTimeoutMs);
    }
    await this.board.reconcile();
    return wave;
  }

  private handleNoDecision(base: SupervisorState, escalatedJobs: Job[]): SupervisorState {
    // "No decision" means nothing is dispatchable — running jobs may still be in flight, and the
    // completion contract says isComplete only when no pending/wounded/running work remains.
    const running = this.board.getSnapshot().jobs.filter((j) => j.status === "running");
    if (running.length > 0) {
      return {
        ...base,
        isComplete: false,
        isTerminal: false,
        lastError: `${running.length} job(s) still running: ${running.map((j) => j.id).join(", ")}; awaiting completion`,
      };
    }

    return {
      ...base,
      isComplete: true,
      isTerminal: true,
      lastError:
        escalatedJobs.length > 0
          ? `${escalatedJobs.length} job(s) escalated after exhausting retries: ${base.failedJobIds.join(", ")}`
          : undefined,
    };
  }

  private handlePolicyEscalation(base: SupervisorState): SupervisorState {
    this.memory?.increment("escalations");
    this.telemetry.record(
      this.tenantId,
      {
        eventType: "routing_decision",
        latencyMs: 0,
        confidence: 1.0,
        model: "policy",
      },
      { action: "policy_escalate_human", reason: "Zero idle workers available" }
    );

    return {
      ...base,
      requiresHuman: true,
      isTerminal: true,
      lastError: "Zero idle workers available; policy escalation triggered",
    };
  }

  private handleSuccessfulDispatch(
    base: SupervisorState,
    decision: DispatchDecision,
    recoveryCount: number
  ): SupervisorState {
    if (!decision.jobId || !decision.workerId) {
      return { ...base, lastError: `Unresolved dispatch decision: ${decision.action}` };
    }

    if (!this.board.assign(decision.jobId, decision.workerId)) {
      return {
        ...base,
        degraded: decision.degraded ?? false,
        fallbackReason: decision.fallbackReason,
        lastError: `Dispatch rejected: ${decision.jobId} -> ${decision.workerId} (worker busy or job not dispatchable); will retry next turn`,
      };
    }

    if (decision.degraded) {
      this.memory?.increment("degraded");
      this.telemetry.record(
        this.tenantId,
        {
          eventType: "dispatch_degraded",
          latencyMs: decision.latencyMs,
          confidence: decision.confidence,
          model: "policy",
        },
        { jobId: decision.jobId, workerId: decision.workerId, reason: decision.fallbackReason }
      );
    }

    if (decision.isRecovery) {
      this.memory?.increment("recoveries");
      this.telemetry.record(
        this.tenantId,
        {
          eventType: "recovery_dispatch",
          latencyMs: decision.latencyMs,
          confidence: decision.confidence,
          model: this.coordinator.modelName,
        },
        {
          jobId: decision.jobId,
          workerId: decision.workerId,
          action: decision.action,
        }
      );
    }

    return {
      ...base,
      currentJobId: decision.jobId,
      assignedWorkerId: decision.workerId,
      degraded: decision.degraded ?? false,
      fallbackReason: decision.fallbackReason,
      recoveryCount: recoveryCount + (decision.isRecovery ? 1 : 0),
    };
  }

  /**
   * Handles a worker node crash in a LangGraph execution branch.
   * Preserves wounded state and marks worker dead so the next supervisor turn recovers.
   */
  public async handleWorkerFailure(workerId: string, error: Error | string): Promise<void> {
    const errStr = typeof error === "string" ? error : error.message;
    await this.board.markWorkerDeath(workerId, errStr);
    this.runScript.push({ kind: "worker_death", workerId, reason: errStr });
    this.memory?.increment("workerDeaths");
    this.memory?.recordFailure({
      action: "worker_failure",
      workerId,
      error: errStr,
      timestamp: Date.now(),
    });
    await this.memory?.autoSyncFromEnv(process.env, true).catch(() => null);
    this.telemetry.record(
      this.tenantId,
      {
        eventType: "worker_death",
        latencyMs: 0,
        confidence: 1.0,
        model: "runtime",
      },
      {
        workerId,
        error: errStr,
      }
    );
  }

  /**
   * Runs the completion gate and acts on it. A pre-validated evidence envelope (deferred dogfooding
   * finding #2) is honored as verified-by-issuer — S3.1 heal semantics apply and the issuer is
   * credited on the completion event — while everything else, plain string evidence included, runs
   * the calibrated gate (Exp 83) exactly as before: green completes the job (healing a wounded/
   * pending one to `done`), red releases the worker and requeues the job (or escalates it when
   * retries are exhausted).
   */
  public async verifyAndComplete(
    jobId: string,
    evidence: string
  ): Promise<{ verified: boolean; confidence: number; latencyMs: number; jobStatus: JobStatus | "missing" }> {
    const job = this.board.getSnapshot().jobs.find((j) => j.id === jobId);
    if (!job) {
      return { verified: false, confidence: 0, latencyMs: 0, jobStatus: "missing" };
    }

    // Advisory-strict envelope check: honored only when the digest binds the claimed summary, the
    // scope names this job, and the deterministic policy floor has not block-flagged the run — the
    // floor stays supreme, so a token can never bless a destructive run. Anything else falls
    // through to the calibrated gate below, exactly as plain string evidence: never weaker.
    const token = parseEvidenceToken(evidence);
    const claimed =
      token !== undefined &&
      token.scope === jobId &&
      classifyOfflinePolicy({ title: job.title, target: job.target, summary: token.summary }).verdict !== "block"
        ? token
        : undefined;

    if (claimed) {
      const claim = claimed.summary.length > 200 ? `${claimed.summary.slice(0, 200)}…` : claimed.summary;
      // Verified-pending-integrator: terminal truth with the S3.1 heal. No gate counters move here —
      // the token is pre-validated by its issuer, not a calibrated-gate verdict, so it must not feed
      // the calibration loop that reads gatesGreen/gatesRed.
      const jobStatus = this.board.completeJob(jobId, evidence, { verified: true, verifiedBy: claimed.issuedBy })
        ? "done"
        : job.status;
      this.board.logEvent({
        type: "oracle_pass",
        jobId,
        detail: `Completion gate green (100%): evidence token, verifiedBy: ${claimed.issuedBy}: ${claim}`,
      });
      this.telemetry.record(
        this.tenantId,
        { eventType: "completion_gate", latencyMs: 0, confidence: 1.0, model: "evidence-token" },
        { jobId, verified: true, jobStatus, verifiedBy: claimed.issuedBy }
      );
      return { verified: true, confidence: 1.0, latencyMs: 0, jobStatus };
    }

    const gate = await this.coordinator.verifyCompletion(job, evidence);
    const summary = evidence.length > 200 ? `${evidence.slice(0, 200)}…` : evidence;

    let jobStatus: JobStatus | "missing";
    if (gate.verified) {
      // A verified complete is terminal truth: it heals a wounded/pending job to `done`, so no later
      // plan wave can re-dispatch it. The board guard still refuses terminal statuses and unknown ids.
      jobStatus = this.board.completeJob(jobId, evidence, { verified: true }) ? "done" : job.status;
      this.memory?.increment("gatesGreen");
    } else {
      jobStatus = await this.board.failJob(jobId, `Completion gate red (${(gate.confidence * 100).toFixed(0)}%)`);
      this.memory?.increment("gatesRed");
      this.memory?.recordFailure({
        action: "completion_gate_red",
        jobId,
        workerId: job.workerId,
        error: summary,
        timestamp: Date.now(),
      });
      await this.memory?.autoSyncFromEnv(process.env, true).catch(() => null);
    }
    this.board.logEvent({
      type: "oracle_pass",
      jobId,
      detail: gate.verified
        ? `Completion gate green (${(gate.confidence * 100).toFixed(0)}%): ${summary}`
        : `Completion gate red (${(gate.confidence * 100).toFixed(0)}%); job requeued: ${summary}`,
    });

    this.telemetry.record(
      this.tenantId,
      {
        eventType: "completion_gate",
        latencyMs: gate.latencyMs,
        confidence: gate.confidence,
        model: this.coordinator.modelName,
      },
      { jobId, verified: gate.verified, jobStatus }
    );

    return { ...gate, jobStatus };
  }

  /** Quarantines a worker, requeuing its jobs and recording the oversight action. */
  public async quarantineWorker(workerId: string, reason = "Quarantined by oversight"): Promise<boolean> {
    const quarantined = await this.board.quarantineWorker(workerId, reason);
    if (quarantined) {
      this.memory?.increment("quarantines");
      this.telemetry.record(
        this.tenantId,
        { eventType: "oversight_quarantine", latencyMs: 0, confidence: 1.0, model: "runtime" },
        { workerId, reason }
      );
    }
    return quarantined;
  }

  /**
   * Applies an {@link OversightStream} verdict to the run: quarantine, reroute, or halt.
   * Returns true when the verdict changed anything.
   */
  public async applyOversightVerdict(
    workerId: string,
    verdict: OversightVerdict,
    reason = "Oversight verdict"
  ): Promise<boolean> {
    switch (verdict) {
      case "continue":
        return false;
      case "quarantine_worker":
        return this.quarantineWorker(workerId, reason);
      case "reroute_job": {
        const currentJobId = this.board
          .getSnapshot()
          .workers.find((w) => w.id === workerId)?.currentJobId;
        if (!currentJobId) return false;
        await this.board.failJob(currentJobId, reason);
        return true;
      }
      case "halt_run":
        this.halt(reason);
        return true;
    }
  }

  /**
   * The apply-once-per-version calibration helper shared by the supervisor's turn maintenance and
   * the MCP shield path (the shield middleware holds the same contract): parses a memory-stored
   * profile and hands it to `target` at most once per profile version, returning the version now
   * applied. Clamping to safety bounds is the target's own `applyProfile` job.
   */
  public static applyProfileOnce(
    raw: unknown,
    appliedVersion: number,
    target: { applyProfile(profile: CalibrationProfile): ProfileApplication }
  ): number {
    const profile = parseCalibrationProfile(raw);
    if (!profile || profile.version === appliedVersion) return appliedVersion;
    target.applyProfile(profile);
    return profile.version;
  }

  /** Stops dispatching: `supervise()` returns `halted: true` until {@link resume}. */
  public halt(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
    this.board.logEvent({ type: "state_change", detail: `Run halted: ${reason}` });
  }

  /** Clears a halt so supervision can continue. */
  public resume(): void {
    this.halted = false;
    this.haltReason = undefined;
  }

  /** The recorded run script (decisions + worker deaths) for {@link SwarmCoordinator.replay}. */
  public exportRunScript(): ReplayStep[] {
    return this.runScript.map((step) =>
      step.kind === "decision" ? { kind: "decision", entry: { ...step.entry } } : { ...step }
    );
  }

  /**
   * Builds a viewer-ready replay artifact: the run script, the board state it ended on, and the
   * decision hash — scrubbed and integrity-hashed for the hosted replay viewer.
   */
  public exportRunArtifact(options: { projectId?: string; scrubber?: (text: string) => string } = {}): RunArtifact {
    return buildRunArtifact({
      script: this.runScript,
      board: this.board,
      projectId: options.projectId ?? this.memory?.projectId,
      scrubber: options.scrubber,
    });
  }

  public completeJob(jobId: string, evidence: string): boolean {
    return this.board.completeJob(jobId, evidence);
  }

  public getBlackboard(): Blackboard {
    return this.board;
  }


  public async classifyCircuit(taskDescription: string): Promise<CircuitClassification> {
    return this.coordinator.classifyCircuit(taskDescription);
  }
}
