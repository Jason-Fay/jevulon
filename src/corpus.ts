/**
 * Versioned corpus store — the moat's storage contract (PROJECT_PHASES.md S1.1, SS-SC-53/54).
 *
 * The corpus is an APPEND-ONLY log of adjudicated cases plus tombstones:
 * - `schemaVersion: 1`; every case record carries provenance
 *   `{ admittingPipeline, protocolVersion, evidenceHash, admittedAt }` — a write without complete
 *   provenance is refused with `CorpusWriteError("unattributed")` and nothing is appended.
 * - A case is admitted exactly once and is NEVER edited or deleted. A retraction appends a
 *   `tombstone { caseId, successor?, reason, at }` which shadows the case: the live view loses the
 *   case and gains the tombstone, while the original admit record stays in the log byte-for-byte.
 * - Export is deterministic, diffable JSON — object keys sorted, cases and tombstones sorted by
 *   `caseId`, 2-space indented — so corpus changes review as line diffs. Replaying the raw append
 *   log reproduces the export byte-for-byte (`replayCorpusLog`).
 *
 * The hosted control plane (`server/control-plane.ts`) and the lab-side corpus consume this same
 * `CorpusStore` interface. `FileCorpusStore` resolves its directory via `SENTINEL_CORPUS_DIR`,
 * defaulting to `<dataDir>/corpus` (see `resolveCorpusDir`).
 */
import fs from "node:fs";
import path from "node:path";

export const CORPUS_SCHEMA_VERSION = 1;

/** Attribution every admitted case carries: who admitted it, under which protocol, on what evidence. */
export interface CaseProvenance {
  /** Pipeline that admitted the case (e.g. "jev-experiments:lab", "control-plane:promote"). */
  admittingPipeline: string;
  /** Version of the admitting protocol. */
  protocolVersion: string;
  /** Hash of the evidence the adjudication rests on. */
  evidenceHash: string;
  /** ISO-8601 admission timestamp. */
  admittedAt: string;
}

export interface CorpusCase {
  caseId: string;
  payload: unknown;
  provenance: CaseProvenance;
}

/** Retraction record. Never an edit of the case it shadows — a new append-only record. */
export interface Tombstone {
  caseId: string;
  /** Successor case, when the retraction supersedes rather than withdraws. */
  successor?: string;
  reason: string;
  at: string;
}

export interface CorpusAdmitInput {
  caseId: string;
  payload?: unknown;
  /**
   * REQUIRED at runtime: a write without complete provenance is refused. Optional in the type so
   * the refusal stays expressible (and testable) for TypeScript callers without casts.
   */
  provenance?: Partial<CaseProvenance> | null;
}

export interface TombstoneInput {
  caseId: string;
  successor?: string | null;
  reason: string;
  at: string;
}

export interface CorpusStore {
  /** Appends one case. Throws `CorpusWriteError("unattributed")` on missing/incomplete provenance. */
  admit(input: CorpusAdmitInput): CorpusCase;
  /** Appends a tombstone for a live case. Throws when the case is unknown or already retracted. */
  retract(input: TombstoneInput): Tombstone;
  /** Live (non-retracted) case, or null. */
  get(caseId: string): CorpusCase | null;
  /** Deterministic, diffable JSON export of the live corpus (see module docstring). */
  export(): string;
}

export type CorpusWriteReason =
  | "unattributed"
  | "invalid-case"
  | "duplicate-case"
  | "unknown-case"
  | "already-retracted"
  | "invalid-tombstone"
  | "io";

/** Typed refusal: the store rejected the write and the append log is untouched. */
export class CorpusWriteError extends Error {
  constructor(
    message: string,
    public readonly reason: CorpusWriteReason,
    public readonly caseId?: string,
  ) {
    super(message);
    this.name = "CorpusWriteError";
  }
}

// ─── Validation (runtime, not type-level: request bodies arrive untyped) ──────

function requireText(value: unknown, field: string, reason: CorpusWriteReason): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CorpusWriteError(`corpus write refused: \`${field}\` must be a non-empty string`, reason);
  }
  return value;
}

function requireProvenance(value: unknown): CaseProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CorpusWriteError("corpus write refused: unattributed write (complete provenance required)", "unattributed");
  }
  const source = value as Partial<CaseProvenance>;
  return {
    admittingPipeline: requireText(source.admittingPipeline, "provenance.admittingPipeline", "unattributed"),
    protocolVersion: requireText(source.protocolVersion, "provenance.protocolVersion", "unattributed"),
    evidenceHash: requireText(source.evidenceHash, "provenance.evidenceHash", "unattributed"),
    admittedAt: requireText(source.admittedAt, "provenance.admittedAt", "unattributed"),
  };
}

// ─── Append log, replay, and deterministic export ─────────────────────────────

interface AdmitRecord {
  kind: "admit";
  schemaVersion: number;
  caseId: string;
  payload: unknown;
  provenance: CaseProvenance;
}

interface TombstoneRecord {
  kind: "tombstone";
  schemaVersion: number;
  caseId: string;
  successor?: string;
  reason: string;
  at: string;
}

type LogRecord = AdmitRecord | TombstoneRecord;

interface CorpusState {
  cases: Map<string, CorpusCase>;
  tombstones: Map<string, Tombstone>;
}

function applyRecord(state: CorpusState, record: LogRecord, source: string, line: number): void {
  if (record.kind === "admit") {
    if (state.cases.has(record.caseId) || state.tombstones.has(record.caseId)) {
      throw new Error(`${source}: corrupt corpus append log at line ${line}: duplicate case "${record.caseId}"`);
    }
    state.cases.set(record.caseId, { caseId: record.caseId, payload: record.payload, provenance: record.provenance });
    return;
  }
  if (!state.cases.delete(record.caseId)) {
    throw new Error(`${source}: corrupt corpus append log at line ${line}: tombstone for unknown case "${record.caseId}"`);
  }
  const { kind: _kind, schemaVersion: _schemaVersion, ...tombstone } = record;
  state.tombstones.set(record.caseId, tombstone);
}

function foldLog(text: string, source: string): CorpusState {
  const state: CorpusState = { cases: new Map(), tombstones: new Map() };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${source}: corrupt corpus append log at line ${index + 1}: not JSON`);
    }
    const shape = typeof record === "object" && record !== null ? (record as { kind?: unknown; schemaVersion?: unknown }) : null;
    if (shape === null || (shape.kind !== "admit" && shape.kind !== "tombstone")) {
      throw new Error(`${source}: corrupt corpus append log at line ${index + 1}: unknown record kind`);
    }
    if (shape.schemaVersion !== CORPUS_SCHEMA_VERSION) {
      throw new Error(`${source}: corrupt corpus append log at line ${index + 1}: schemaVersion ${String(shape.schemaVersion)} unsupported`);
    }
    applyRecord(state, record as LogRecord, source, index + 1);
  }
  return state;
}

function byCaseId(a: { caseId: string }, b: { caseId: string }): number {
  if (a.caseId < b.caseId) return -1;
  if (a.caseId > b.caseId) return 1;
  return 0;
}

/** Recursively sorted keys — same payload content always serializes to the same bytes. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
  return sorted;
}

function serializeState(state: CorpusState): string {
  const cases = [...state.cases.values()].sort(byCaseId);
  const tombstones = [...state.tombstones.values()].sort(byCaseId);
  return JSON.stringify(canonicalize({ schemaVersion: CORPUS_SCHEMA_VERSION, cases, tombstones }), null, 2) + "\n";
}

/**
 * Replays a raw append log and reproduces the corpus byte-for-byte: identical bytes to
 * `FileCorpusStore#export()` over the same log (SS-SC-54). Throws on a log that cannot be replayed.
 */
export function replayCorpusLog(logText: string): string {
  return serializeState(foldLog(logText, "corpus append log"));
}

// ─── Data dir resolution ──────────────────────────────────────────────────────

/** `SENTINEL_CORPUS_DIR` wins; otherwise `<dataDir>/corpus` (contract #5's paths use the env form). */
export function resolveCorpusDir(dataDir: string, env: Record<string, string | undefined> = process.env): string {
  const override = env.SENTINEL_CORPUS_DIR;
  return override !== undefined && override.trim() !== "" ? override : path.join(dataDir, "corpus");
}

// ─── File-backed store ────────────────────────────────────────────────────────

/**
 * File-backed `CorpusStore`: one append-only JSONL log (`append.jsonl`) that IS the corpus —
 * state is folded from it at construction and every write is a single appended line before it is
 * reflected in memory. A refused write (attribution/duplication/policy) appends nothing; an I/O
 * failure surfaces as `CorpusWriteError("io")` so callers can fail the request instead of silently
 * diverging from the log the replay guarantee rests on.
 */
export class FileCorpusStore implements CorpusStore {
  private readonly logPath: string;
  private readonly state: CorpusState = { cases: new Map(), tombstones: new Map() };

  constructor(options: { dir: string }) {
    this.logPath = path.join(options.dir, "append.jsonl");
    fs.mkdirSync(options.dir, { recursive: true });
    if (fs.existsSync(this.logPath)) {
      const loaded = foldLog(fs.readFileSync(this.logPath, "utf8"), this.logPath);
      this.state.cases = loaded.cases;
      this.state.tombstones = loaded.tombstones;
    }
  }

  private appendLine(line: string): void {
    try {
      fs.appendFileSync(this.logPath, line + "\n", "utf8");
    } catch {
      throw new CorpusWriteError("corpus write refused: append failed, nothing recorded", "io");
    }
  }

  admit(input: CorpusAdmitInput): CorpusCase {
    const source: Partial<CorpusAdmitInput> = input ?? {};
    const caseId = requireText(source.caseId, "caseId", "invalid-case");
    const provenance = requireProvenance(source.provenance);
    if (this.state.cases.has(caseId) || this.state.tombstones.has(caseId)) {
      throw new CorpusWriteError(`corpus write refused: case "${caseId}" already exists (append-only)`, "duplicate-case", caseId);
    }
    const record: AdmitRecord = {
      kind: "admit",
      schemaVersion: CORPUS_SCHEMA_VERSION,
      caseId,
      payload: source.payload ?? null,
      provenance,
    };
    // The serialized line is the source of truth: memory reflects exactly what the log holds (JSON
    // round-trip), so the caller's payload object can never mutate the recorded case afterwards.
    const line = JSON.stringify(record);
    this.appendLine(line);
    const stored = JSON.parse(line) as AdmitRecord;
    const admitted: CorpusCase = { caseId, payload: stored.payload, provenance: stored.provenance };
    this.state.cases.set(caseId, admitted);
    return admitted;
  }

  retract(input: TombstoneInput): Tombstone {
    const source: Partial<TombstoneInput> = input ?? {};
    const caseId = requireText(source.caseId, "caseId", "invalid-case");
    if (this.state.tombstones.has(caseId)) {
      throw new CorpusWriteError(`corpus write refused: case "${caseId}" is already retracted (never an edit)`, "already-retracted", caseId);
    }
    if (!this.state.cases.has(caseId)) {
      throw new CorpusWriteError(`corpus write refused: unknown case "${caseId}"`, "unknown-case", caseId);
    }
    const reason = requireText(source.reason, "reason", "invalid-tombstone");
    const at = requireText(source.at, "at", "invalid-tombstone");
    const successor =
      source.successor === undefined || source.successor === null ? undefined : requireText(source.successor, "successor", "invalid-tombstone");
    if (successor !== undefined) {
      if (successor === caseId) {
        throw new CorpusWriteError(`corpus write refused: tombstone successor must differ from "${caseId}"`, "invalid-tombstone", caseId);
      }
      if (!this.state.cases.has(successor)) {
        throw new CorpusWriteError(`corpus write refused: tombstone successor "${successor}" is not a live case`, "invalid-tombstone", caseId);
      }
    }
    const record: TombstoneRecord = {
      kind: "tombstone",
      schemaVersion: CORPUS_SCHEMA_VERSION,
      caseId,
      ...(successor !== undefined ? { successor } : {}),
      reason,
      at,
    };
    this.appendLine(JSON.stringify(record));
    const { kind: _kind, schemaVersion: _schemaVersion, ...tombstone } = record;
    this.state.cases.delete(caseId);
    this.state.tombstones.set(caseId, tombstone);
    return tombstone;
  }

  get(caseId: string): CorpusCase | null {
    return this.state.cases.get(caseId) ?? null;
  }

  export(): string {
    return serializeState(this.state);
  }
}
