/**
 * Replay artifact: the frozen, versioned payload a hosted replay viewer consumes.
 *
 * An artifact is self-contained and tamper-EVIDENT: every field is canonicalized, hashed, and
 * re-verified on parse, and the decision hash inside the run block is cross-checked against the
 * steps. That catches inconsistent edits, not a motivated forger — real tamper-resistance needs a
 * host signature over `integrity.hash`, which the envelope carries via `signature` (never hashed).
 */
import crypto from "node:crypto";
import type { Blackboard } from "./blackboard.js";
import type { DecisionLogEntry, ReplayReport, ReplayStep } from "./coordinator.js";
import { SwarmCoordinator } from "./coordinator.js";
import { RunArtifactIntegrityError } from "./errors.js";
import { scrubSecrets } from "./telemetry.js";
import type { JobStatus, WorkerStatus } from "./types.js";

export const RUN_ARTIFACT_KIND = "swarm-sentinel.run";
export const RUN_ARTIFACT_VERSION = 1;

export interface ArtifactJob {
  id: string;
  title: string;
  status: JobStatus;
  workerId?: string;
  attempts: number;
  error?: string;
}

export interface ArtifactWorker {
  id: string;
  name: string;
  status: WorkerStatus;
  currentJobId?: string;
}

export interface ArtifactState {
  activeWave: number;
  jobs: ArtifactJob[];
  workers: ArtifactWorker[];
}

export interface RunArtifact {
  artifact: typeof RUN_ARTIFACT_KIND;
  version: typeof RUN_ARTIFACT_VERSION;
  createdAt: number;
  projectId?: string;
  run: {
    waves: number;
    decisionHash: string;
    steps: ReplayStep[];
    finalState: ArtifactState;
  };
  verification?: ReplayReport;
  integrity: { algorithm: "sha256"; hash: string };
  signature?: { scheme: string; value: string };
}

export type RunArtifactContent = Omit<RunArtifact, "integrity" | "signature">;

export interface BuildRunArtifactOptions {
  script: ReplayStep[];
  board: Blackboard;
  report?: ReplayReport;
  projectId?: string;
  scrubber?: (text: string) => string;
  createdAt?: number;
  signature?: { scheme: string; value: string };
}

const JOB_STATUSES: JobStatus[] = ["pending", "running", "wounded", "done", "escalated"];
const WORKER_STATUSES: WorkerStatus[] = ["idle", "busy", "dead", "quarantined"];

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && JOB_STATUSES.includes(value as JobStatus); // membership checked against the literal set
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  return typeof value === "string" && WORKER_STATUSES.includes(value as WorkerStatus); // membership checked against the literal set
}

type Scrubber = (text: string) => string;

function isDecisionStep(step: ReplayStep): step is Extract<ReplayStep, { kind: "decision" }> {
  return step.kind === "decision";
}

/** Rebuilds a step with a fixed key order so serialization and hashing are stable. */
function canonicalStep(step: ReplayStep): ReplayStep {
  if (step.kind === "worker_death") {
    return { kind: "worker_death", workerId: step.workerId, ...(step.reason === undefined ? {} : { reason: step.reason }) };
  }
  const entry = step.entry;
  return {
    kind: "decision",
    entry: {
      wave: entry.wave,
      action: entry.action,
      ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
      ...(entry.workerId === undefined ? {} : { workerId: entry.workerId }),
      confidence: entry.confidence,
      latencyMs: entry.latencyMs,
      isRecovery: entry.isRecovery,
      ...(entry.fallback === undefined ? {} : { fallback: entry.fallback }),
      ...(entry.degraded === undefined ? {} : { degraded: entry.degraded }),
      ...(entry.fallbackReason === undefined ? {} : { fallbackReason: entry.fallbackReason }),
      timestamp: entry.timestamp,
    },
  };
}

function canonicalReport(report: ReplayReport): ReplayReport {
  return {
    decisions: report.decisions,
    applied: report.applied,
    divergences: report.divergences.map((d) => ({ index: d.index, expected: d.expected, reason: d.reason })),
    hash: report.hash,
    matches: report.matches,
  };
}

function canonicalState(state: ArtifactState): ArtifactState {
  return {
    activeWave: state.activeWave,
    jobs: state.jobs.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      ...(job.workerId === undefined ? {} : { workerId: job.workerId }),
      attempts: job.attempts,
      ...(job.error === undefined ? {} : { error: job.error }),
    })),
    workers: state.workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      status: worker.status,
      ...(worker.currentJobId === undefined ? {} : { currentJobId: worker.currentJobId }),
    })),
  };
}

function canonicalContent(content: RunArtifactContent): RunArtifactContent {
  return {
    artifact: RUN_ARTIFACT_KIND,
    version: RUN_ARTIFACT_VERSION,
    createdAt: content.createdAt,
    ...(content.projectId === undefined ? {} : { projectId: content.projectId }),
    run: {
      waves: content.run.waves,
      decisionHash: content.run.decisionHash,
      steps: content.run.steps.map(canonicalStep),
      finalState: canonicalState(content.run.finalState),
    },
    ...(content.verification === undefined ? {} : { verification: canonicalReport(content.verification) }),
  };
}

/** SHA-256 over the canonical content — the tamper-evidence anchor a host would sign. */
export function artifactIntegrityHash(content: RunArtifactContent): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalContent(content))).digest("hex");
}

/** Builds a viewer-ready artifact from a run script and the board it ended on. */
export function buildRunArtifact(options: BuildRunArtifactOptions): RunArtifact {
  const scrub: Scrubber = options.scrubber ?? scrubSecrets;
  const snapshot = options.board.getSnapshot();

  const steps = options.script.map((step) =>
    canonicalStep(
      step.kind === "worker_death"
        ? { kind: "worker_death", workerId: scrub(step.workerId), ...(step.reason === undefined ? {} : { reason: scrub(step.reason) }) }
        : { kind: "decision", entry: scrubEntry(step.entry, scrub) }
    )
  );
  const decisions = steps.filter(isDecisionStep).map((step) => step.entry);

  const content: RunArtifactContent = {
    artifact: RUN_ARTIFACT_KIND,
    version: RUN_ARTIFACT_VERSION,
    createdAt: options.createdAt ?? Date.now(),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    run: {
      waves: decisions.reduce((max, entry) => Math.max(max, entry.wave), 0),
      decisionHash: SwarmCoordinator.hashDecisionEntries(decisions),
      steps,
      finalState: {
        activeWave: snapshot.activeWave,
        jobs: snapshot.jobs.map((job) => ({
          id: scrub(job.id),
          title: scrub(job.title),
          status: job.status,
          ...(job.workerId === undefined ? {} : { workerId: scrub(job.workerId) }),
          attempts: job.attempts,
          ...(job.error === undefined ? {} : { error: scrub(job.error) }),
        })),
        workers: snapshot.workers.map((worker) => ({
          id: scrub(worker.id),
          name: scrub(worker.name),
          status: worker.status,
          ...(worker.currentJobId === undefined ? {} : { currentJobId: scrub(worker.currentJobId) }),
        })),
      },
    },
    ...(options.report === undefined ? {} : { verification: canonicalReport(scrubReport(options.report, scrub)) }),
  };

  return {
    ...content,
    integrity: { algorithm: "sha256", hash: artifactIntegrityHash(content) },
    ...(options.signature === undefined ? {} : { signature: options.signature }),
  };
}

/** Returns a new artifact carrying a replay report, with the integrity hash recomputed. */
export function attachVerification(artifact: RunArtifact, report: ReplayReport): RunArtifact {
  const { integrity: _integrity, signature, ...content } = artifact;
  const next: RunArtifactContent = { ...canonicalContent(content), verification: canonicalReport(scrubReport(report, scrubSecrets)) };
  return {
    ...next,
    integrity: { algorithm: "sha256", hash: artifactIntegrityHash(next) },
    ...(signature === undefined ? {} : { signature }),
  };
}

/** True when the artifact's content still hashes to its recorded integrity value. */
export function verifyRunArtifact(artifact: RunArtifact): boolean {
  const { integrity: _integrity, signature: _signature, ...content } = artifact;
  return artifactIntegrityHash(content) === artifact.integrity.hash;
}

export function serializeRunArtifact(artifact: RunArtifact): string {
  return `${JSON.stringify(canonicalArtifact(artifact), null, 2)}\n`;
}

/**
 * Parses and validates an artifact (object or JSON text). Throws {@link RunArtifactIntegrityError}
 * on malformed content, a broken integrity hash, or a decision hash that disagrees with the steps.
 */
export function parseRunArtifact(raw: unknown): RunArtifact {
  let candidate: unknown = raw;
  if (typeof raw === "string") {
    try {
      candidate = JSON.parse(raw);
    } catch (error) {
      throw new RunArtifactIntegrityError(`artifact: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (candidate === null || typeof candidate !== "object") {
    throw new RunArtifactIntegrityError("artifact: root must be an object");
  }
  if (!("artifact" in candidate) || candidate.artifact !== RUN_ARTIFACT_KIND) {
    throw new RunArtifactIntegrityError(`artifact: expected kind "${RUN_ARTIFACT_KIND}"`);
  }
  if (!("version" in candidate) || candidate.version !== RUN_ARTIFACT_VERSION) {
    throw new RunArtifactIntegrityError(`artifact: unsupported version (expected ${RUN_ARTIFACT_VERSION})`);
  }
  if (!("createdAt" in candidate) || typeof candidate.createdAt !== "number") {
    throw new RunArtifactIntegrityError("artifact: missing createdAt");
  }
  if (!("run" in candidate) || candidate.run === null || typeof candidate.run !== "object") {
    throw new RunArtifactIntegrityError("artifact: missing run block");
  }

  const run = candidate.run;
  if (!("steps" in run) || !Array.isArray(run.steps)) throw new RunArtifactIntegrityError("artifact: run.steps must be an array");
  if (!("finalState" in run) || run.finalState === null || typeof run.finalState !== "object") {
    throw new RunArtifactIntegrityError("artifact: run.finalState is missing");
  }
  if (!("decisionHash" in run) || typeof run.decisionHash !== "string") {
    throw new RunArtifactIntegrityError("artifact: run.decisionHash is missing");
  }
  if (!("integrity" in candidate) || candidate.integrity === null || typeof candidate.integrity !== "object" || !("hash" in candidate.integrity) || typeof candidate.integrity.hash !== "string") {
    throw new RunArtifactIntegrityError("artifact: integrity block is missing");
  }

  const content: RunArtifactContent = {
    artifact: RUN_ARTIFACT_KIND,
    version: RUN_ARTIFACT_VERSION,
    createdAt: candidate.createdAt,
    ...("projectId" in candidate && typeof candidate.projectId === "string" ? { projectId: candidate.projectId } : {}),
    run: {
      waves: "waves" in run && typeof run.waves === "number" ? run.waves : 0,
      decisionHash: run.decisionHash,
      steps: run.steps.map((step, index) => parseStep(step, index)),
      finalState: parseState(run.finalState),
    },
    ...("verification" in candidate && candidate.verification !== undefined ? { verification: parseReport(candidate.verification) } : {}),
  };

  const expected = artifactIntegrityHash(content);
  if (expected !== candidate.integrity.hash) {
    throw new RunArtifactIntegrityError(
      "artifact: integrity check failed — the content does not match its recorded hash",
      expected,
      candidate.integrity.hash
    );
  }

  const decisions = content.run.steps.filter(isDecisionStep).map((step) => step.entry);
  const recomputedDecisionHash = SwarmCoordinator.hashDecisionEntries(decisions);
  if (recomputedDecisionHash !== content.run.decisionHash) {
    throw new RunArtifactIntegrityError(
      "artifact: decision hash disagrees with the recorded steps",
      recomputedDecisionHash,
      content.run.decisionHash
    );
  }

  return {
    ...content,
    integrity: { algorithm: "sha256", hash: expected },
    ...("signature" in candidate && candidate.signature !== null && typeof candidate.signature === "object" && "scheme" in candidate.signature && typeof candidate.signature.scheme === "string" && "value" in candidate.signature && typeof candidate.signature.value === "string"
      ? { signature: { scheme: candidate.signature.scheme, value: candidate.signature.value } }
      : {}),
  };
}

/** Human-readable header for a viewer or CLI. */
export function runArtifactSummary(artifact: RunArtifact): string {
  const decisions = artifact.run.steps.filter(isDecisionStep).length;
  const deaths = artifact.run.steps.length - decisions;
  const byStatus = new Map<string, number>();
  for (const job of artifact.run.finalState.jobs) {
    byStatus.set(job.status, (byStatus.get(job.status) ?? 0) + 1);
  }
  const jobs = [...byStatus.entries()].map(([status, count]) => `${count} ${status}`).join(", ") || "none";
  const lines = [
    `${artifact.artifact} v${artifact.version}`,
    `created   ${new Date(artifact.createdAt).toISOString()}${artifact.projectId ? `  project ${artifact.projectId}` : ""}`,
    `run       ${decisions} decision(s), ${deaths} worker death(s), ${artifact.run.waves} wave(s)`,
    `state     waves=${artifact.run.finalState.activeWave} jobs=[${jobs}] workers=${artifact.run.finalState.workers.length}`,
    `hashes    decision ${artifact.run.decisionHash} · integrity ${artifact.integrity.hash.slice(0, 16)}…`,
  ];
  if (artifact.verification) {
    lines.push(
      `replay    ${artifact.verification.applied}/${artifact.verification.decisions} applied · ${artifact.verification.divergences.length} divergence(s) · ${artifact.verification.matches ? "MATCH" : "MISMATCH"}`
    );
  }
  if (artifact.signature) {
    lines.push(`signature ${artifact.signature.scheme}`);
  }
  return lines.join("\n");
}

function scrubEntry(entry: DecisionLogEntry, scrub: Scrubber): DecisionLogEntry {
  return {
    ...entry,
    action: scrub(entry.action),
    ...(entry.jobId === undefined ? {} : { jobId: scrub(entry.jobId) }),
    ...(entry.workerId === undefined ? {} : { workerId: scrub(entry.workerId) }),
  };
}

/** Scrubs the text inputs of a replay report before canonicalization — never after hashing. */
function scrubReport(report: ReplayReport, scrub: Scrubber): ReplayReport {
  return {
    decisions: report.decisions,
    applied: report.applied,
    divergences: report.divergences.map((divergence) => ({
      index: divergence.index,
      expected: scrub(divergence.expected),
      reason: scrub(divergence.reason),
    })),
    hash: scrub(report.hash),
    matches: report.matches,
  };
}

function canonicalArtifact(artifact: RunArtifact): RunArtifact {
  return {
    ...canonicalContent(artifact),
    integrity: { algorithm: "sha256", hash: artifact.integrity.hash },
    ...(artifact.signature === undefined ? {} : { signature: { scheme: artifact.signature.scheme, value: artifact.signature.value } }),
  };
}

function parseStep(value: unknown, index: number): ReplayStep {
  if (value === null || typeof value !== "object" || !("kind" in value)) {
    throw new RunArtifactIntegrityError(`artifact: step #${index} is malformed`);
  }
  if (value.kind === "worker_death") {
    if (!("workerId" in value) || typeof value.workerId !== "string") {
      throw new RunArtifactIntegrityError(`artifact: step #${index} (worker_death) is missing workerId`);
    }
    return {
      kind: "worker_death",
      workerId: value.workerId,
      ...("reason" in value && typeof value.reason === "string" ? { reason: value.reason } : {}),
    };
  }
  if (value.kind === "decision" && "entry" in value && value.entry !== null && typeof value.entry === "object") {
    const entry = value.entry;
    if (
      !("wave" in entry) || !("action" in entry) || !("confidence" in entry) ||
      !("latencyMs" in entry) || !("isRecovery" in entry) || !("timestamp" in entry)
    ) {
      throw new RunArtifactIntegrityError(`artifact: step #${index} (decision) is missing required entry fields`);
    }
    if (
      typeof entry.wave !== "number" || typeof entry.action !== "string" ||
      typeof entry.confidence !== "number" || typeof entry.latencyMs !== "number" ||
      typeof entry.isRecovery !== "boolean" || typeof entry.timestamp !== "number"
    ) {
      throw new RunArtifactIntegrityError(`artifact: step #${index} (decision) has mistyped entry fields`);
    }
    return {
      kind: "decision",
      entry: {
        wave: entry.wave,
        action: entry.action,
        ...("jobId" in entry && typeof entry.jobId === "string" ? { jobId: entry.jobId } : {}),
        ...("workerId" in entry && typeof entry.workerId === "string" ? { workerId: entry.workerId } : {}),
        confidence: entry.confidence,
        latencyMs: entry.latencyMs,
        isRecovery: entry.isRecovery,
        ...("fallback" in entry && typeof entry.fallback === "boolean" ? { fallback: entry.fallback } : {}),
        ...("degraded" in entry && typeof entry.degraded === "boolean" ? { degraded: entry.degraded } : {}),
        ...("fallbackReason" in entry && (entry.fallbackReason === "invalid_answer" || entry.fallbackReason === "transport")
          ? { fallbackReason: entry.fallbackReason }
          : {}),
        timestamp: entry.timestamp,
      },
    };
  }
  throw new RunArtifactIntegrityError(`artifact: step #${index} has an unknown kind`);
}

function parseReport(value: unknown): ReplayReport {
  if (value === null || typeof value !== "object") throw new RunArtifactIntegrityError("artifact: verification block is malformed");
  const report = value;
  if (
    !("decisions" in report) || typeof report.decisions !== "number" ||
    !("applied" in report) || typeof report.applied !== "number" ||
    !("hash" in report) || typeof report.hash !== "string" ||
    !("matches" in report) || typeof report.matches !== "boolean" ||
    !("divergences" in report) || !Array.isArray(report.divergences)
  ) {
    throw new RunArtifactIntegrityError("artifact: verification block has invalid fields");
  }
  const divergences = report.divergences.map((divergence, index) => {
    if (
      divergence === null || typeof divergence !== "object" ||
      !("index" in divergence) || typeof divergence.index !== "number" ||
      !("expected" in divergence) || typeof divergence.expected !== "string" ||
      !("reason" in divergence) || typeof divergence.reason !== "string"
    ) {
      throw new RunArtifactIntegrityError(`artifact: divergence #${index} is malformed`);
    }
    return { index: divergence.index, expected: divergence.expected, reason: divergence.reason };
  });
  return { decisions: report.decisions, applied: report.applied, divergences, hash: report.hash, matches: report.matches };
}

function parseState(value: object): ArtifactState {
  if (!("activeWave" in value) || typeof value.activeWave !== "number") {
    throw new RunArtifactIntegrityError("artifact: finalState.activeWave is missing");
  }
  if (!("jobs" in value) || !Array.isArray(value.jobs) || !("workers" in value) || !Array.isArray(value.workers)) {
    throw new RunArtifactIntegrityError("artifact: finalState must carry jobs and workers arrays");
  }
  const jobs = value.jobs.map((job, index) => {
    if (
      job === null || typeof job !== "object" ||
      !("id" in job) || typeof job.id !== "string" ||
      !("title" in job) || typeof job.title !== "string" ||
      !("attempts" in job) || typeof job.attempts !== "number" ||
      !("status" in job) || !isJobStatus(job.status)
    ) {
      throw new RunArtifactIntegrityError(`artifact: finalState job #${index} is malformed`);
    }
    return {
      id: job.id,
      title: job.title,
      status: job.status,
      ...("workerId" in job && typeof job.workerId === "string" ? { workerId: job.workerId } : {}),
      attempts: job.attempts,
      ...("error" in job && typeof job.error === "string" ? { error: job.error } : {}),
    };
  });
  const workers = value.workers.map((worker, index) => {
    if (
      worker === null || typeof worker !== "object" ||
      !("id" in worker) || typeof worker.id !== "string" ||
      !("name" in worker) || typeof worker.name !== "string" ||
      !("status" in worker) || !isWorkerStatus(worker.status)
    ) {
      throw new RunArtifactIntegrityError(`artifact: finalState worker #${index} is malformed`);
    }
    return {
      id: worker.id,
      name: worker.name,
      status: worker.status,
      ...("currentJobId" in worker && typeof worker.currentJobId === "string" ? { currentJobId: worker.currentJobId } : {}),
    };
  });
  return { activeWave: value.activeWave, jobs, workers };
}
