/**
 * Core Type Definitions for Swarm Sentinel
 * Zero-Token Multi-Agent Orchestration & Real-Time Safety Oversight
 */

export type JobStatus = "pending" | "running" | "wounded" | "done" | "escalated";
export type WorkerStatus = "idle" | "busy" | "dead" | "quarantined";
export type DataSensitivity = "open" | "standard" | "restricted";

export interface Job {
  id: string;
  title: string;
  target?: string;
  /** Data sensitivity tier (open | standard | restricted). Inferred from `target`/`title` when omitted. */
  sensitivity?: DataSensitivity;
  status: JobStatus;
  workerId?: string;
  evidence?: string;
  error?: string;
  attempts: number;
}

export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus;
  /** Maximum sensitivity tier this worker/model is trusted to handle (defaults to "restricted" when omitted). */
  trustTier?: DataSensitivity;
  currentJobId?: string;
  lastHeartbeat: number;
}

export interface BlackboardEvent {
  timestamp: number;
  type:
    | "state_change"
    | "tool_call"
    | "oracle_pass"
    | "worker_death"
    | "redispatch"
    | "quarantine"
    | "policy_fallback"
    | "dispatch_rejected";
  workerId?: string;
  jobId?: string;
  detail: string;
}

export interface BlackboardSnapshot {
  jobs: Job[];
  workers: Worker[];
  events: BlackboardEvent[];
  activeWave: number;
}

// ---- JEV Wire Types ----
export type QuestionType = "choice" | "score" | "noul";

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionsMap = Record<string, Question>;

export interface JevAnswer {
  type?: QuestionType;
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface JevEvaluationResult {
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  model: string;
}

// ---- Coordination & Oversight Types ----
export interface DispatchDecision {
  action: string;
  jobId?: string;
  workerId?: string;
  confidence: number;
  latencyMs: number;
  isRecovery: boolean;
  /** True when the action came from a deterministic fallback rather than a valid JEV answer. */
  fallback?: boolean;
  /** True when the JEV endpoint was unavailable and a deterministic dispatch was used. */
  degraded?: boolean;
  fallbackReason?: "invalid_answer" | "transport";
}

export type OversightVerdict = "continue" | "quarantine_worker" | "reroute_job" | "halt_run";

export interface OversightEvaluation {
  verdict: OversightVerdict;
  confidence: number;
  reason?: string;
  latencyMs: number;
}

export type ShieldVerdict = "allow" | "block" | "escalate_human";

export interface ShieldEvaluation {
  verdict: ShieldVerdict;
  riskScore: number;
  destructiveProbability: number;
  reason: string;
  latencyMs: number;
  /**
   * Verdict of the deterministic offline policy engine. The model may only tighten it, never loosen it:
   * a live model that answers "allow" cannot move the verdict below this floor.
   */
  floorVerdict?: ShieldVerdict;
  /**
   * Rule that produced the floor verdict (e.g. `recursive-force-delete-outside-workspace`).
   * When the floor blocks in live mode no model call happens, so `riskScore`/`destructiveProbability`
   * carry the offline severity (4.0 / 1.0) rather than model output.
   */
  floorRule?: string;
}

export type ExecutionCircuit = "standard_circuit" | "style_circuit";

export interface CircuitDecision {
  circuit: ExecutionCircuit;
  confidence: number;
  latencyMs: number;
  reason: string;
}
