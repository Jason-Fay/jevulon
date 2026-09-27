/**
 * Swarm Sentinel MCP server.
 *
 * Design commitments (see README §0):
 * - Blocks are terminal: an approval can never turn a `block` into an execution.
 * - Escalations are DENIED by default; approval is single-use, bound to the exact action payload
 *   (canonical fingerprint), and expires. A decision attributed to the identity that requested the
 *   escalation is refused - the gated agent cannot authorize itself.
 * - All tool input is validated at runtime - a JSON string "false" is not approval.
 * - Supervision is delegated to SwarmSupervisor, so waves, recovery, the calibrated completion
 *   gate, and usage counters come from the same code paths the library ships and tests.
 * - stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import readline from "node:readline";
import { SwarmShield } from "../shield.js";
import { OversightStream } from "../oversight.js";
import { Blackboard } from "../blackboard.js";
import { SwarmCoordinator } from "../coordinator.js";
import { ProjectMemory } from "../memory.js";
import { TelemetryCollector } from "../telemetry.js";
import { JevClient } from "../client.js";
import { SwarmSupervisor } from "../langgraph/supervisor.js";
import type { SupervisorState } from "../langgraph/supervisor.js";
import type { ShieldEvaluation, OversightEvaluation } from "../types.js";
import {
  ToolInputError,
  validateApproveArgs,
  validateInspectArgs,
  validateCodeReviewArgs,
  validateMonitorArgs,
  validatePresenceArgs,
  validateSuperviseArgs,
} from "./validate.js";
import type { ApproveToolArgs, CodeReviewToolArgs, InspectToolArgs, MonitorToolArgs, PresenceToolArgs, SuperviseToolArgs } from "./validate.js";
import { listTools } from "./tools.js";
import { runCodeReview } from "./review.js";
import { runSuperviseAction } from "./supervise.js";
import type { SuperviseSession } from "./supervise.js";
import { PresenceBoard } from "../presence.js";
import { DEFAULT_ESCALATION_TTL_MS, EscalationStore, fingerprintOf } from "./escalations.js";
import type { EscalationRequest } from "./escalations.js";
export { DEFAULT_ESCALATION_TTL_MS, EscalationStore, canonicalJson, fingerprintOf } from "./escalations.js";
export type { EscalationRequest, EscalationStatus } from "./escalations.js";

export interface McpServerOptions {
  client?: JevClient;
  memoryPath?: string;
  simulation?: boolean;
  /** Explicit presence-board file; otherwise resolved from the repository layout (shared by worktrees). */
  boardPath?: string;
  /** Identity recorded on the board; defaults to `SWARM_SENTINEL_AGENT` or `mcp#<pid>`. */
  agentId?: string;
  /** How long a pending escalation stays answerable (default 15 minutes). */
  escalationTtlMs?: number;
  /** Telemetry collector for MCP-surface events; defaults to one fresh collector per server instance. Wire a sink (e.g. the OTel exporter) to ship them. */
  telemetry?: TelemetryCollector;
  /** Tenant label hashed into telemetry events (default `default_tenant`). */
  tenantId?: string;
}

/**
 * Optional operator attribution on an approval decision, validated in the `validate.ts` style: a
 * wrong-typed field is an error - never a truthiness coercion.
 */
function validateApproveAttribution(tool: string, args: Record<string, unknown>): { approvedBy?: string } {
  const value = args.approvedBy;
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new ToolInputError(tool, "approvedBy", "approvedBy must be a string when provided");
  }
  if (value.length > 256) {
    throw new ToolInputError(tool, "approvedBy", "approvedBy exceeds 256 characters");
  }
  return { approvedBy: value };
}

export class McpServer {
  private shield: SwarmShield;
  private appliedShieldProfileVersion = -1;
  private oversight: OversightStream;
  private board: Blackboard;
  private coordinator: SwarmCoordinator;
  private supervisor?: SwarmSupervisor;
  private memory?: ProjectMemory;
  private telemetry: TelemetryCollector;
  private tenantId: string;
  private client: JevClient;
  private memoryPath?: string;
  private escalationTtlMs: number;
  private escalations: EscalationStore;
  private readonly agentId: string;
  private boardPath?: string;
  private presenceState?: PresenceBoard;
  private lastPresenceTouch = 0;
  private lastState: Partial<SupervisorState> = {};
  private isInitialized = false;

  constructor(options: McpServerOptions = {}) {
    this.client = options.client || new JevClient({ simulation: options.simulation });
    this.shield = new SwarmShield({ client: this.client });
    this.oversight = new OversightStream({ client: this.client });
    this.board = new Blackboard();
    this.coordinator = new SwarmCoordinator({ client: this.client });
    this.memoryPath = options.memoryPath;
    this.telemetry = options.telemetry ?? new TelemetryCollector();
    this.tenantId = options.tenantId ?? "default_tenant";
    this.escalationTtlMs = options.escalationTtlMs ?? DEFAULT_ESCALATION_TTL_MS;
    this.escalations = new EscalationStore(this.escalationTtlMs);
    this.agentId = options.agentId ?? process.env.SWARM_SENTINEL_AGENT ?? `mcp#${process.pid}`;
    this.boardPath = options.boardPath;
  }

  /** Lazily opened so constructing a server costs nothing until presence is actually used. */
  private presenceStore(): PresenceBoard {
    this.presenceState ??= new PresenceBoard(this.boardPath === undefined ? {} : { path: this.boardPath });
    return this.presenceState;
  }

  /**
   * Liveness heartbeat, throttled and never fatal: presence is an advisory surface, so a failure to
   * record it must not affect the tool call in flight.
   */
  private touchPresence(): void {
    if (Date.now() - this.lastPresenceTouch < 20_000) return;
    this.lastPresenceTouch = Date.now();
    try {
      this.presenceStore().registerAgent(this.agentId, process.env.SWARM_SENTINEL_AGENT_KIND ?? "mcp");
    } catch {
      // Advisory only.
    }
  }

  public async init(memoryPath?: string): Promise<void> {
    if (this.isInitialized) return;
    try {
      this.memory = await ProjectMemory.open({ path: memoryPath ?? this.memoryPath });
    } catch (error) {
      // Memory is best-effort, but silence would be a lie: say so on stderr.
      process.stderr.write(`[jvii] telemetry memory disabled: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await this.memory?.autoSyncFromEnv().catch(() => null);
    this.supervisor = new SwarmSupervisor({
      board: this.board,
      coordinator: this.coordinator,
      memory: this.memory,
      workers: [],
      // One collector per McpServer instance: the supervise flow's record() calls at their
      // counter-bump sites (worker_death, routing_decision, recovery_dispatch, …) land where
      // the MCP surface can ship them.
      telemetry: this.telemetry,
      tenantId: this.tenantId,
    });
    this.isInitialized = true;
  }

  public getMemory(): ProjectMemory | undefined {
    return this.memory;
  }

  public getBlackboard(): Blackboard {
    return this.board;
  }

  public getCoordinator(): SwarmCoordinator {
    return this.coordinator;
  }

  public getClient(): JevClient {
    return this.client;
  }

  public getEscalations(): EscalationRequest[] {
    return this.escalations.list();
  }

  /**
   * sentinel_shield_inspect - evaluates a command or tool call before execution.
   * Blocks are terminal. Escalations are denied unless an unconsumed, unexpired approval matches
   * the exact payload; approval is consumed on use.
   */
  public async handleShieldInspect(args: InspectToolArgs): Promise<Record<string, unknown>> {
    await this.init();
    this.escalations.prune();
    this.memory?.increment("shieldInspections");
    // A synced profile must tighten this path too, not just the completion gate.
    this.appliedShieldProfileVersion = SwarmSupervisor.applyProfileOnce(
      this.memory?.getProfile(),
      this.appliedShieldProfileVersion,
      this.shield
    );

    const evaluation = await this.shield.inspectAction(args);
    const base = {
      riskScore: evaluation.riskScore,
      destructiveProbability: evaluation.destructiveProbability,
      latencyMs: evaluation.latencyMs,
      ...(evaluation.floorRule === undefined ? {} : { floorRule: evaluation.floorRule, floorVerdict: evaluation.floorVerdict }),
    };

    if (evaluation.verdict === "block") {
      this.memory?.increment("shieldBlocks", 1);
      this.telemetry.record(
        this.tenantId,
        {
          eventType: "shield_block",
          latencyMs: evaluation.latencyMs,
          confidence: evaluation.destructiveProbability,
          model: "jev-latest",
        },
        {
          tool: args.commandOrTool,
          reason: evaluation.reason,
          riskScore: evaluation.riskScore,
        }
      );
      await this.memory?.flush();
      return { verdict: "block", allowed: false, ...base, reason: evaluation.reason };
    }

    if (evaluation.verdict === "allow") {
      return { verdict: "allow", allowed: true, ...base, reason: evaluation.reason };
    }

    // Escalation path.
    const fingerprint = fingerprintOf(args);
    const approved = this.escalations.find(fingerprint, "approved");
    if (approved) {
      this.escalations.consume(approved);
      return {
        verdict: "escalate_human",
        allowed: true,
        ...base,
        reason: `${evaluation.reason} Operator authorization ${approved.approvalId} accepted - consumed now, single use.`,
        approvalId: approved.approvalId,
        approvalConsumed: true,
      };
    }

    const denied = this.escalations.find(fingerprint, "denied");
    if (denied) {
      return {
        verdict: "escalate_human",
        allowed: false,
        ...base,
        reason: `Denied by operator at ${new Date(denied.decidedAt ?? denied.createdAt).toISOString()}. A denied action stays denied for this payload until the request expires.`,
        actionId: denied.actionId,
        deniedByOperator: true,
      };
    }

    let pending = this.escalations.find(fingerprint, "pending");
    if (!pending) {
      pending = this.escalations.create({ fingerprint, commandOrTool: args.commandOrTool, evaluation, requestedBy: this.agentId });
      this.memory?.increment("shieldEscalations", 1);
      this.telemetry.record(
        this.tenantId,
        {
          eventType: "shield_escalation",
          latencyMs: evaluation.latencyMs,
          confidence: evaluation.destructiveProbability,
          model: "jev-latest",
        },
        {
          tool: args.commandOrTool,
          reason: evaluation.reason,
          riskScore: evaluation.riskScore,
        }
      );
      await this.memory?.flush();
    }
    return {
      verdict: "escalate_human",
      allowed: false,
      ...base,
      reason: evaluation.reason,
      actionId: pending.actionId,
      expiresAt: pending.expiresAt,
      instructions:
        `Requires operator approval. Ask a human to call sentinel_approve_escalation with actionId "${pending.actionId}" ` +
        `(single-use, bound to this exact payload, expires ${new Date(pending.expiresAt).toISOString()}).`,
    };
  }

  /**
   * sentinel_approve_escalation - operator authorization for one exact payload.
   * This tool is only a human gate if the MCP host is configured to prompt for it. The decision is
   * attributed to `approvedBy` (recorded as `unattributed` when the host attributes nothing) and
   * refused when that identity is the one that requested the escalation.
   */
  public async handleApproveEscalation(args: ApproveToolArgs & { approvedBy?: string }): Promise<Record<string, unknown>> {
    await this.init();
    this.escalations.prune();

    const request = this.escalations.decide(args.actionId, args.approved, args.approvedBy);

    return {
      actionId: request.actionId,
      status: request.status,
      approvalId: request.approvalId,
      approvedBy: request.approvedBy,
      commandOrTool: request.commandOrTool,
      expiresAt: request.expiresAt,
      message: args.approved
        ? `Action "${request.commandOrTool}" APPROVED (single-use authorization ${request.approvalId}, valid until ${new Date(request.expiresAt).toISOString()}).`
        : `Action "${request.commandOrTool}" DENIED for this payload until the request expires.`,
    };
  }

  /** sentinel_oversight_monitor - evaluates a worker trace for loops and deadlocks. */
  public async handleOversightMonitor(args: MonitorToolArgs): Promise<OversightEvaluation> {
    await this.init();
    this.memory?.increment("oversightEvaluations");
    const evaluation = await this.oversight.evaluateEvent(args);
    if (this.supervisor && evaluation.verdict !== "continue") {
      await this.supervisor.applyOversightVerdict(
        args.workerId,
        evaluation.verdict,
        evaluation.reason ?? "Oversight verdict"
      );
      await this.memory?.flush();
    } else if (evaluation.verdict === "quarantine_worker") {
      this.memory?.increment("quarantines", 1);
      this.telemetry.record(
        this.tenantId,
        { eventType: "oversight_quarantine", latencyMs: 0, confidence: 1.0, model: "runtime" },
        { workerId: args.workerId, reason: evaluation.reason ?? "Oversight verdict" }
      );
      await this.memory?.flush();
    }
    return evaluation;
  }

  /** sentinel_supervise - dispatches work through the recovery supervisor. */
  public async handleSupervise(args: SuperviseToolArgs): Promise<Record<string, unknown>> {
    await this.init();
    const supervisor = this.supervisor;
    if (!supervisor) throw new Error("supervisor unavailable");

    const session: SuperviseSession = { board: this.board, supervisor, lastState: this.lastState };
    const result = await runSuperviseAction(session, args);
    this.lastState = session.lastState;
    return result;
  }

  /** sentinel_get_status - current board, supervisor state, and usage counters. */
  public async handleGetStatus(): Promise<Record<string, unknown>> {
    await this.init();
    this.escalations.prune();
    const snapshot = this.board.getSnapshot();

    return {
      simulation: this.client.simulation,
      wave: this.lastState.wave ?? snapshot.activeWave,
      requiresHuman: this.lastState.requiresHuman ?? false,
      halted: this.lastState.halted ?? false,
      escalated: this.lastState.escalated ?? false,
      activeWave: snapshot.activeWave,
      jobsCount: snapshot.jobs.length,
      workersCount: snapshot.workers.length,
      pendingJobs: snapshot.jobs.filter((job) => job.status === "pending" || job.status === "wounded").length,
      idleWorkers: snapshot.workers.filter((worker) => worker.status === "idle").length,
      escalations: this.escalations.counts(),
      counters: this.memory?.usage ?? {},
    };
  }

  /**
   * sentinel_presence - the shared board for agents that never talk to each other.
   * Advisory by construction: claims and trails inform, they never block (the shield floor does that).
   */
  public async handlePresence(args: PresenceToolArgs): Promise<Record<string, unknown>> {
    await this.init();
    const store = this.presenceStore();
    this.memory?.increment("presenceChecks");
    const callerId = typeof args.agentId === "string" && args.agentId.trim() ? args.agentId.trim() : this.agentId;

    if (args.action === "checkpoint") {
      const state = store.checkpoint(callerId, args.paths === undefined ? {} : { paths: args.paths });
      await this.memory?.flush();
      return {
        action: "checkpoint",
        agentId: callerId,
        since: state.since ?? null,
        now: state.now,
        changed: state.changed,
        claims: state.claims,
        conflicts: state.conflicts,
        hot: state.hot,
        directives: state.directives,
        signals: state.signals,
        escalations: state.escalations,
        conditionalInstructions: state.conditionalInstructions,
        note: "Take this before an irreversible step; acknowledge anything owed with { action: \"ack\", directiveId }.",
      };
    }

    if (args.action === "claim") {
      const paths = args.paths ?? [];
      if (paths.length === 0) throw new Error("paths are required for claim");
      store.registerAgent(callerId, process.env.SWARM_SENTINEL_AGENT_KIND ?? "mcp");
      store.heartbeat(callerId);
      const mode = args.mode ?? "edit";
      const conflicts = store.conflicts(callerId, paths, mode);
      if (conflicts.length > 0) this.memory?.increment("claimConflicts");
      // Overlaps that do not contend (any read claim is an observer) are informational, not conflicts.
      const observers = store
        .claims({ paths }, Date.now())
        .filter((record) => record.agentId !== callerId && !conflicts.some((c) => c.agentId === record.agentId && c.path === record.path));
      const claims = store.claim(callerId, paths, {
        mode,
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(args.ttlMinutes === undefined ? {} : { ttlMs: args.ttlMinutes * 60_000 }),
      });
      const doc = store.read();
      const recentPathEvents = doc.events
        .filter((e) => paths.some((p) => e.detail && e.detail.includes(p)))
        .slice(-5)
        .reverse()
        .map((e) => ({
          actor: e.actor,
          action: e.type,
          file: e.detail,
          ...(e.rationale ? { rationale: e.rationale } : {}),
        }));
      return {
        action: "claim",
        board: store.path,
        agentId: callerId,
        claims: claims.map((record) => ({ path: record.path, mode: record.mode, expiresAt: record.expiresAt })),
        conflicts: conflicts.map((record) => ({
          path: record.path,
          heldBy: record.agentId,
          mode: record.mode,
          ...(record.note === undefined ? {} : { why: record.note }),
        })),
        recentActivityOnPaths: recentPathEvents,
        summary:
          conflicts.length > 0
            ? "another agent holds some of these paths - coordinate before editing"
            : observers.length > 0
              ? `informational overlap: ${observers.map((record) => `${record.agentId} ${record.mode} ${record.path}`).join(", ")} - a read claim is an observer, not a conflict`
              : "no other agent holds these paths",
        signals: store.signals({}, Date.now()),
        directives: this.pendingDirectives(callerId),
        conditionalInstructions: store.resolveConditionalInstructions(paths),
      };
    }

    if (args.action === "release") {
      const pathsToCheck = args.paths ?? [];
      const syntaxErrors: string[] = [];
      for (const p of pathsToCheck) {
        // Confine the pre-release syntax gate to bounded workspace files: the path list is
        // client-supplied MCP input (MCP-PRESENCE-FILEREAD).
        const resolved = path.resolve(process.cwd(), p);
        const relative = path.relative(process.cwd(), resolved);
        const inWorkspace = !relative.startsWith("..") && !path.isAbsolute(relative);
        if (inWorkspace && resolved.endsWith(".html") && fs.existsSync(resolved) && fs.statSync(resolved).size <= 256 * 1024) {
          const content = fs.readFileSync(resolved, "utf8");
          const scriptMatches = content.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);
          for (const m of scriptMatches) {
            try {
              new vm.Script(m[1]);
            } catch (err: any) {
              syntaxErrors.push(`${p}: <script> syntax error - ${err.message}`);
            }
          }
        }
      }
      if (syntaxErrors.length > 0) {
        throw new Error(`Release rejected by pre-release syntax gate:\n${syntaxErrors.join("\n")}\nFix syntax errors before releasing claims.`);
      }
      const released = store.release(callerId, args.paths);
      return { action: "release", board: store.path, agentId: callerId, released };
    }

    if (args.action === "directives") {
      return {
        action: "directives",
        agentId: callerId,
        directives: store.directives(callerId),
        escalations: store.escalations(),
        note: "Directives are advisory: acknowledge with { action: \"ack\", directiveId } and close with { action: \"resolve\", directiveId }.",
      };
    }

    if (args.action === "ack") {
      const record = store.acknowledge(String(args.directiveId), callerId, args.note);
      this.memory?.increment("directivesAcked");
      await this.memory?.flush();
      return { action: "ack", directiveId: record.id, kind: record.kind, target: record.target, ackedAt: record.ack?.at };
    }

    if (args.action === "resolve") {
      const record = store.resolveDirective(String(args.directiveId), callerId);
      return { action: "resolve", directiveId: record.id, resolvedAt: record.resolvedAt };
    }

    if (args.action === "signal") {
      const record = store.signal(String(args.key), args.value, callerId, {
        ...(args.ttlMinutes === undefined ? {} : { ttlMs: args.ttlMinutes * 60_000 }),
      });
      return {
        action: "signal",
        key: record.key,
        value: record.value,
        author: record.author,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
        // The signal TTL policy travels with the response: default 15 minutes, capped at 1440  - 
        // durable findings (e.g. gap/*) ask for the hours they need instead of re-signalling.
        ttlMinutes: Math.round(((record.expiresAt ?? record.updatedAt) - record.updatedAt) / 60_000),
        note: "Signals expire after ttlMinutes (default 15 minutes, max 1440): post durable findings (e.g. gap/*) with an explicit ttlMinutes instead of re-signalling.",
      };
    }

    if (args.action === "direct") {
      const outcome = store.direct(String(args.agentId), {
        kind: args.kind ?? "reprioritize",
        target: String(args.target),
        issuedBy: args.issuedBy ?? callerId,
        ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
        ...(args.ttlMinutes === undefined ? {} : { ttlMs: args.ttlMinutes * 60_000 }),
      });
      if (outcome.refused) {
        return { action: "direct", refused: true, reason: outcome.reason };
      }
      this.memory?.increment("directivesIssued");
      await this.memory?.flush();
      return {
        action: "direct",
        refused: false,
        directive: {
          id: outcome.directive.id,
          agentId: outcome.directive.agentId,
          kind: outcome.directive.kind,
          target: outcome.directive.target,
          expiresAt: outcome.directive.expiresAt,
        },
      };
    }

    if (args.action === "allocate") {
      const queueKey = args.queueKey ?? "default";
      const items = args.items ?? [];
      const item = store.allocate(callerId, queueKey, items);
      return {
        action: "allocate",
        agentId: callerId,
        queueKey,
        item,
        exhausted: item === null,
      };
    }

    if (args.action === "alarm") {
      const key = args.target || args.key || (args.paths ? args.paths[0] : undefined);
      if (!key) throw new Error("target, key, or path is required for alarm");
      store.depositAlarm(key, args.note);
      return { action: "alarm", key, note: args.note };
    }

    if (args.action === "attract") {
      const key = args.target || args.key || (args.paths ? args.paths[0] : undefined);
      if (!key) throw new Error("target, key, or path is required for attract");
      store.depositAttractant(key, args.note);
      return { action: "attract", key, note: args.note };
    }

    return {
      action: "read",
      ...store.presence({
        agentId: callerId,
        ...(args.paths === undefined ? {} : { paths: args.paths }),
      }),
    };
  }

  /** Tools exposed over MCP. */
  public getToolsList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return listTools();
  }

  /** Validates and dispatches a tool call. Never throws: errors come back as isError content. */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }> {
    try {
      this.touchPresence();
      let result: unknown;
      switch (name) {
        case "sentinel_shield_inspect":
          result = await this.handleShieldInspect(validateInspectArgs(name, args));
          break;
        case "sentinel_approve_escalation":
          result = await this.handleApproveEscalation({
            ...validateApproveArgs(name, args),
            ...validateApproveAttribution(name, args),
          });
          break;
        case "sentinel_oversight_monitor":
          result = await this.handleOversightMonitor(validateMonitorArgs(name, args));
          break;
        case "sentinel_supervise":
          result = await this.handleSupervise(validateSuperviseArgs(name, args));
          break;
        case "sentinel_get_status":
          result = await this.handleGetStatus();
          break;
        case "sentinel_presence":
          result = await this.handlePresence(validatePresenceArgs(name, args));
          break;
        case "sentinel_code_review": {
          const reviewArgs: CodeReviewToolArgs = validateCodeReviewArgs(name, args);
          result = await runCodeReview({ filePath: reviewArgs.filePath, sourceCode: reviewArgs.sourceCode, runs: reviewArgs.runs });
          break;
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      const targetAgentId = typeof args?.agentId === "string" && args.agentId.trim() ? args.agentId.trim() : undefined;
      const pending = name === "sentinel_presence" ? [] : this.pendingDirectives(targetAgentId);
      const delivered =
        pending.length > 0 && result !== null && typeof result === "object" && !Array.isArray(result)
          ? { ...(result as Record<string, unknown>), directives: pending }
          : result;
      return { content: [{ type: "text", text: JSON.stringify(delivered, null, 2) }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  }

  /**
   * Directives addressed to this agent, attached to whatever it asked for next. Delivery is not
   * acknowledgement: the agent still has to say it saw the directive, which is what makes an ignored
   * directive visible instead of silent.
   */
  private pendingDirectives(agentId?: string): Array<Record<string, unknown>> {
    const targetId = agentId && agentId.trim() ? agentId.trim() : this.agentId;
    try {
      return this.presenceStore()
        .directives(targetId)
        .filter((record) => record.ack === undefined) // delivered once; acknowledgement is the agent's own act
        .map((record) => ({
          id: record.id,
          kind: record.kind,
          target: record.target,
          issuedBy: record.issuedBy,
          ...(record.rationale === undefined ? {} : { why: record.rationale }),
          expiresAt: record.expiresAt,
          ackWith: { action: "ack", directiveId: record.id },
        }));
    } catch {
      return []; // Advisory surface: a delivery failure never affects the tool result itself.
    }
  }

  /**
   * One JSON-RPC 2.0 line in, one response object out (undefined for blanks and notifications).
   * Only a true parse failure answers `-32700`; a handler failure answers `-32603` with the request
   * id preserved, so a client can tell "you sent garbage" from "the server failed this call".
   */
  public async handleJsonRpcLine(line: string): Promise<Record<string, unknown> | undefined> {
    const trimmed = line.trim();
    if (!trimmed) return undefined;

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${message}` } };
    }

    if (request === null || typeof request !== "object") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: not an object" } };
    }

    const id = "id" in request ? request.id : undefined;
    const method = "method" in request && typeof request.method === "string" ? request.method : undefined;
    const params = "params" in request && request.params !== null && typeof request.params === "object" ? request.params : {};

    // JSON-RPC 2.0 & MCP: Notifications have no id and MUST NEVER receive a response.
    if (id === undefined || (typeof method === "string" && method.startsWith("notifications/"))) {
      return undefined;
    }

    try {
      let response: Record<string, unknown>;

      if (method === "initialize") {
        response = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "jvii", version: "0.1.0" },
            capabilities: { tools: {} },
            instructions:
              "JEVULON VII (JVII) Autonomous Multi-Agent Control & Safety Layer:\n" +
              "JEVULON VII operates autonomously in the background to coordinate workers, prevent file collisions, and manage execution recovery without peer chatter.\n" +
              "1. Autonomous Stigmergic Coordination: Coordinate via the shared blackboard (sentinel_presence). Claim files before editing ({ action: 'claim', paths: ['...'], mode: 'edit' }), check for conflicts ({ action: 'checkpoint' }), and release when done ({ action: 'release' }). Directives and steering ride in-band on tool responses.\n" +
              "2. Supervised Wave Execution: Multi-agent tasks, wave dispatch, worker recovery, and completion gates are driven through sentinel_supervise.\n" +
              "3. Autonomous Safety & Policy: Safety checks are enforced automatically by the runtime. DO NOT call sentinel_shield_inspect for routine development (file reads, edits, git status/diff, test/build runs). Only invoke sentinel_shield_inspect when about to execute high-risk, irreversible, or destructive system operations.",
          },
        };
      } else if (method === "tools/list") {
        response = { jsonrpc: "2.0", id, result: { tools: this.getToolsList() } };
      } else if (method === "tools/call") {
        const toolName = "name" in params && typeof params.name === "string" ? params.name : "";
        const toolArgs = "arguments" in params && params.arguments !== null && typeof params.arguments === "object"
          ? Object.fromEntries(Object.entries(params.arguments))
          : {};
        response = { jsonrpc: "2.0", id, result: await this.callTool(toolName, toolArgs) };
      } else if (method === "ping") {
        response = { jsonrpc: "2.0", id, result: {} };
      } else if (method === "resources/list") {
        response = { jsonrpc: "2.0", id, result: { resources: [] } };
      } else if (method === "resources/templates/list") {
        response = { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
      } else if (method === "prompts/list") {
        response = { jsonrpc: "2.0", id, result: { prompts: [] } };
      } else {
        response = { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `Method not found: ${String(method)}` } };
      }

      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { jsonrpc: "2.0", id: id ?? null, error: { code: -32603, message: `Internal error: ${message}` } };
    }
  }

  /** stdio JSON-RPC 2.0 loop. stdout carries protocol traffic only. */
  public startStdio(): void {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

    rl.on("line", async (line: string) => {
      if (line.length > 1024 * 1024) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: line length exceeds 1MB limit" },
          }) + "\n"
        );
        return;
      }

      const response = await this.handleJsonRpcLine(line);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });

    process.stderr.write("[jvii] MCP server listening on stdio\n");
  }
}
