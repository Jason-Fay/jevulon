import crypto from "node:crypto";
import { JevClient } from "./client.js";
import { Blackboard } from "./blackboard.js";
import { JevUnavailableError, validateChoice } from "./errors.js";
import type { DecisionEngine } from "./engine.js";
import { clampProfile } from "./profile.js";
import type { CalibrationProfile, ProfileApplication } from "./profile.js";
import type { CircuitDecision, DispatchDecision, ExecutionCircuit, Job } from "./types.js";
import { applyMenuHints, buildDispatchPlan, buildDispatchState, dispatchInstructions, explainMenuMiss } from "./dispatch.js";

/**
 * A {@link CircuitDecision} that reports whether it came from the deterministic semantic fallback
 * rather than a sampled model answer (`fallback: true` means JEV could not answer).
 */
export interface CircuitClassification extends CircuitDecision {
  fallback?: boolean;
}

export interface DecisionLogEntry {
  wave: number;
  action: string;
  jobId?: string;
  workerId?: string;
  confidence: number;
  latencyMs: number;
  isRecovery: boolean;
  fallback?: boolean;
  degraded?: boolean;
  fallbackReason?: "invalid_answer" | "transport";
  /** Scrubbed failure or red-gate test output attached when a worker or completion gate fails. */
  error?: string;
  timestamp: number;
}

/**
 * A recorded run step. Decisions are what the model selected; worker deaths are the state
 * mutations that made recovery decisions necessary - replay needs both to be faithful.
 */
export type ReplayStep =
  | { kind: "decision"; entry: DecisionLogEntry }
  | { kind: "worker_death"; workerId: string; reason?: string };

export interface ReplayDivergence {
  index: number;
  expected: string;
  reason: string;
}

export interface ReplayReport {
  /** Decision steps processed from the script. */
  decisions: number;
  /** Decisions reproduced exactly (menu-valid and applied, or policy-reproduced). */
  applied: number;
  divergences: ReplayDivergence[];
  /** Hash of the decision sequence produced by the replay. */
  hash: string;
  /** True when the replayed sequence is identical to the recorded one. */
  matches: boolean;
}

export interface CoordinatorOptions {
  client?: JevClient;
  /** Custom decision engine. Defaults to `client` (JEV); supply this to run on any other backend. */
  engine?: DecisionEngine;
  completionThreshold?: number;
}

export class SwarmCoordinator {
  private client?: JevClient;
  private engine: DecisionEngine;
  private completionThreshold: number;
  private decisionLog: DecisionLogEntry[] = [];
  /** Menu hints adopted from the last applied profile version (clamped data - see `applyMenuHints`). */
  private menuHints: Record<string, "prefer" | "avoid"> = {};
  /** Version whose hints were adopted: each profile version's hints apply exactly once. */
  private appliedMenuHintsVersion: number | undefined;
  /** Profile verdicts awaiting the next board write (the coordinator owns no board of its own). */
  private pendingProfileLog: string[] = [];

  constructor(options: CoordinatorOptions = {}) {
    if (options.engine) {
      this.client = options.client;
      this.engine = options.engine;
    } else {
      const client = options.client ?? new JevClient();
      this.client = client;
      this.engine = client;
    }
    this.completionThreshold = options.completionThreshold ?? 0.7;
  }

  /** Model identifier of the JEV client backing this coordinator (telemetry labels events with it). */
  public get modelName(): string {
    return this.client?.modelName ?? "custom-engine";
  }

  /**
   * Applies the coordinator-relevant knobs of a calibration profile (clamped to safety bounds: the
   * completion gate may only tighten). Menu hints apply once per profile version (the
   * `applyProfileOnce` pattern) and a hostile hint set is rejected at this gateway and logged.
   */
  public applyProfile(profile: CalibrationProfile): ProfileApplication {
    const { profile: bounded, clamped, rejected } = clampProfile(profile);
    const applied: string[] = [];
    if (bounded.completionThreshold !== undefined) {
      this.completionThreshold = bounded.completionThreshold;
      applied.push("completionThreshold");
    }
    for (const entry of rejected) {
      this.pendingProfileLog.push(`Calibration profile v${profile.version}: ${entry}.`);
    }
    if (bounded.menuHints !== undefined && profile.version !== this.appliedMenuHintsVersion) {
      this.menuHints = bounded.menuHints;
      this.appliedMenuHintsVersion = profile.version;
      applied.push("menuHints");
      this.pendingProfileLog.push(`Calibration profile v${profile.version}: menuHints applied.`);
    }
    return { version: profile.version, applied, clamped, rejected };
  }

  /**
   * Evaluates the blackboard and returns the next optimal typed dispatch decision.
   * Enforces the Menu Policy Theorem (Exp 84): escalation is deterministic policy,
   * never a sampled peer option on the menu.
   *
   * Out-of-vocabulary answers and JEV transport failures fall back to a deterministic
   * dispatch (first candidate pair, stable order) and are flagged on the decision instead of
   * stalling the run or crashing it. Stored menu hints may reorder or filter the offered menu  - 
   * never widen it and never steer this fallback (the offline floor is hint-proof).
   */
  public async planNextAction(board: Blackboard): Promise<DispatchDecision | null> {
    // Profile verdicts (hint adoption / hostile-set rejection) surface on the board exactly once.
    for (const detail of this.pendingProfileLog) {
      board.logEvent({ type: "state_change", detail });
    }
    this.pendingProfileLog = [];

    const plan = buildDispatchPlan(board);

    // Rule 1: No actionable work remaining
    if (!plan) {
      return null;
    }

    // Rule 2: Deterministic Policy Escalation (Exp 84)
    // If work exists but zero idle workers are available, escalate via policy logic, NOT sampled menu
    if (plan.idleWorkers.length === 0) {
      const decision: DispatchDecision = {
        action: "policy_escalate_human",
        confidence: 1.0,
        latencyMs: 0,
        isRecovery: false,
      };
      this.recordDecision(plan.snapshot.activeWave, decision);
      return decision;
    }

    // Rule 3: Dynamic Menu Synthesis with Key-Map (Fixes Bug 1)
    // `menuKeys` stays the un-hinted menu: it names the offline floor. Stored hints reorder or
    // filter only what the model is offered (`offered`) - the candidates and key map are untouched.
    const menuKeys = Object.keys(plan.menu);
    const offered = applyMenuHints(plan.menu, plan.keyMap, this.menuHints);

    // Format the state for JEV (bounded so runaway output cannot inflate the payload)
    const statePayload = buildDispatchState(plan, (target) => board.getAlarm(target));
    const instructions = dispatchInstructions(plan.isRecovery);

    const t0 = Date.now();
    let rawChoice = "";
    let confidence = 0;
    let fallbackReason: DispatchDecision["fallbackReason"];

    try {
      const res = await this.engine.choice(statePayload, instructions, offered);
      rawChoice = res.choice;
      confidence = res.confidence;
    } catch (err) {
      if (!(err instanceof JevUnavailableError)) throw err;
      fallbackReason = "transport";
      board.logEvent({
        type: "policy_fallback",
        detail: `JEV unavailable (${err.message}); using deterministic dispatch fallback.`,
      });
    }

    // Exact ids come from the key map - immune to underscores or special chars. A non-menu answer
    // falls back to the first candidate pair (stable order - exactly what menuKeys[0] names, and
    // what hint reordering must never move) and is flagged; only a live-but-invalid answer is logged
    // here, because a transport failure already logged its own fallback above.
    let chosen = rawChoice;
    let mapping = plan.keyMap.get(chosen);
    if (!mapping) {
      if (fallbackReason === undefined) {
        fallbackReason = "invalid_answer";
        board.logEvent({
          type: "policy_fallback",
          detail: `JEV answered "${rawChoice}", which is not on the dispatch menu; using deterministic fallback ${menuKeys[0]}.`,
        });
      }
      chosen = menuKeys[0];
      mapping = plan.keyMap.get(chosen) ?? { jobId: plan.candidates[0].id, workerId: plan.idleWorkers[0].id };
    }

    const decision: DispatchDecision = {
      action: chosen,
      jobId: mapping.jobId,
      workerId: mapping.workerId,
      confidence,
      latencyMs: Date.now() - t0,
      isRecovery: plan.isRecovery,
      ...(fallbackReason
        ? { fallback: true, degraded: fallbackReason === "transport", fallbackReason }
        : {}),
    };

    this.recordDecision(plan.snapshot.activeWave, decision);
    return decision;
  }

  /**
   * Deterministic Replay Engine (Exp 83).
   * Re-executes a recorded run script - dispatch decisions plus worker deaths - against a board seeded
   * with the same starting state, with ZERO JEV calls: every recorded action is validated against the
   * menu the original decision faced and applied through the board's normal guards.
   *
   * Anything that cannot be reproduced is reported in `divergences`; a clean replay yields
   * `matches: true` and a decision-sequence hash equal to the live run's.
   *
   * Note: replay is an offline operation and REPLACES this coordinator's decision log with the
   * replayed sequence. Use a dedicated coordinator instance if the live log must be preserved.
   */
  public async replay(script: ReplayStep[], board: Blackboard): Promise<ReplayReport> {
    this.decisionLog = [];
    const divergences: ReplayDivergence[] = [];
    let decisions = 0;
    let applied = 0;

    for (const [index, step] of script.entries()) {
      if (step.kind === "worker_death") {
        await board.markWorkerDeath(step.workerId, step.reason ?? "Replay: recorded worker death");
        continue;
      }

      decisions++;
      const entry = step.entry;
      const wave = this.advanceWaveTo(board, entry.wave);
      const plan = buildDispatchPlan(board);

      if (!plan) {
        divergences.push({ index, expected: entry.action, reason: "no actionable work remains on the replay board" });
        continue;
      }

      if (plan.idleWorkers.length === 0) {
        if (entry.action !== "policy_escalate_human") {
          divergences.push({
            index,
            expected: entry.action,
            reason: "recorded dispatch needs an idle worker, but the replay board has none",
          });
          continue;
        }
        this.recordDecision(wave, { action: "policy_escalate_human", confidence: entry.confidence, latencyMs: 0, isRecovery: false });
        applied++;
        continue;
      }

      if (entry.action === "policy_escalate_human") {
        divergences.push({
          index,
          expected: entry.action,
          reason: "recorded policy escalation, but idle workers are available on the replay board",
        });
        continue;
      }

      if (!entry.jobId || !entry.workerId || !plan.keyMap.has(entry.action)) {
        divergences.push({ index, expected: entry.action, reason: explainMenuMiss(plan, entry, board.getSnapshot()) });
        continue;
      }

      if (!board.assign(entry.jobId, entry.workerId)) {
        divergences.push({ index, expected: entry.action, reason: "board guards rejected the recorded assignment" });
        continue;
      }

      this.recordDecision(wave, {
        action: entry.action,
        jobId: entry.jobId,
        workerId: entry.workerId,
        confidence: entry.confidence,
        latencyMs: 0,
        isRecovery: entry.isRecovery,
        fallback: entry.fallback,
        degraded: entry.degraded,
        fallbackReason: entry.fallbackReason,
      });
      applied++;
    }

    const hash = this.getDecisionLogHash();
    const recorded: DecisionLogEntry[] = [];
    for (const step of script) {
      if (step.kind === "decision") recorded.push(step.entry);
    }
    return {
      decisions,
      applied,
      divergences,
      hash,
      matches: hash === SwarmCoordinator.hashDecisionEntries(recorded),
    };
  }

  /** Advances the board's wave counter (with pheromone evaporation) to the recorded wave. */
  private advanceWaveTo(board: Blackboard, wave: number): number {
    let current = board.getSnapshot().activeWave;
    while (current < wave) {
      current = board.nextWave();
    }
    return current;
  }

  /**
   * Evaluates completion evidence using calibrated JEV Noul (Exp 83).
   */
  public async verifyCompletion(
    job: Job,
    evidence: string
  ): Promise<{ verified: boolean; confidence: number; latencyMs: number }> {
    const instructions = `Is this repair/task (${job.id}: ${job.title}) complete and correct, as verified by a full oracle pass? Answer true if verified green, false if errors or failures remain.`;

    const state = {
      jobId: job.id,
      title: job.title,
      target: job.target,
      oracleEvidence: evidence,
    };

    const res = await this.engine.noul(state, instructions);
    return {
      verified: res.noul >= this.completionThreshold,
      confidence: res.noul,
      latencyMs: res.latencyMs,
    };
  }

  /**
   * Evaluates a user task or goal to determine whether it requires an aesthetic Style Circuit
   * (concurrent skeleton + environmental art style barrier) or the Standard Execution Circuit.
   * Evaluated via JEV System One / DecisionEngine with deterministic fallback.
   */
  public async classifyCircuit(taskDescription: string): Promise<CircuitClassification> {
    const t0 = Date.now();
    const isVisual =
      /\b(ui|frontend|css|style|styles|portfolio|dashboard|html|website|webpage|landing\s+page|canvas|animations?|glassmorphic|dark\s+mode|responsive|shader|glsl|hlsl|vfx|particles?|post-processing|lighting|materials?|hud|menu|sprites?|models?|textures?)\b/.test(
        taskDescription.toLowerCase(),
      );
    const semanticFallback: ExecutionCircuit = isVisual ? "style_circuit" : "standard_circuit";

    if (this.client?.simulation) {
      return {
        circuit: semanticFallback,
        confidence: 0.95,
        latencyMs: 15,
        reason: isVisual
          ? "Visual keywords detected in task; simulation selected style_circuit."
          : "No visual presentation keywords detected; simulation selected standard_circuit.",
      };
    }

    const instructions =
      "Analyze the proposed task. Determine whether it is a visual frontend, UI, website, dashboard, or presentation layer requiring cohesive aesthetic design tokens (style_circuit), or a non-visual backend, script, CLI, algorithm, or data pipeline (standard_circuit).";

    const menu: Record<ExecutionCircuit, string> = {
      style_circuit:
        "Visual frontend, UI, website, portfolio, dashboard, or presentation layer requiring aesthetic design tokens, responsive layout, CSS, or styling cohesion",
      standard_circuit:
        "Non-visual backend, script, CLI, algorithm, data pipeline, server, or pure logic task with no aesthetic UI presentation requirements",
    };

    const state = { task: taskDescription.slice(0, 4096) };

    try {
      const res = await this.engine.choice(state, instructions, menu);
      const circuits = Object.keys(menu) as ExecutionCircuit[]; // keys of a local Record<ExecutionCircuit, string>
      const chosen = validateChoice(res.choice, circuits, "SwarmCoordinator.classifyCircuit");
      return {
        circuit: chosen,
        confidence: res.confidence,
        latencyMs: Date.now() - t0,
        reason:
          chosen === "style_circuit"
            ? "Visual or UI presentation layer detected; requires aesthetic design tokens and layout cohesion."
            : "Non-visual or backend logic task; standard parallel circuit applies.",
      };
    } catch (err) {
      if (!(err instanceof JevUnavailableError)) throw err;
      return {
        circuit: semanticFallback,
        confidence: 0.9,
        latencyMs: Date.now() - t0,
        reason: isVisual
          ? "Visual keywords detected in task; fallback selected style_circuit."
          : "No visual presentation keywords detected; fallback selected standard_circuit.",
        fallback: true,
      };
    }
  }

  private recordDecision(wave: number, d: DispatchDecision): void {
    this.decisionLog.push({
      wave,
      action: d.action,
      jobId: d.jobId,
      workerId: d.workerId,
      confidence: d.confidence,
      latencyMs: d.latencyMs,
      isRecovery: d.isRecovery,
      fallback: d.fallback,
      degraded: d.degraded,
      fallbackReason: d.fallbackReason,
      timestamp: Date.now(),
    });
  }

  public getDecisionLog(): DecisionLogEntry[] {
    return [...this.decisionLog];
  }

  /**
   * Generates a deterministic SHA-256 hash of the normalized decision sequence.
   * Enables exact audit comparison across runs (Exp 83).
   */
  public getDecisionLogHash(): string {
    return SwarmCoordinator.hashDecisionEntries(this.decisionLog);
  }

  /** Hashes any decision sequence with the same normalization used for run audits. */
  public static hashDecisionEntries(log: DecisionLogEntry[]): string {
    const normalized = log.map((e) => ({
      wave: e.wave,
      action: e.action,
      jobId: e.jobId,
      workerId: e.workerId,
      isRecovery: e.isRecovery,
      fallback: e.fallback,
      degraded: e.degraded,
      fallbackReason: e.fallbackReason,
    }));
    return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
  }
}
