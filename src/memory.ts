import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { scrubSecrets } from "./telemetry.js";
import type { DecisionLogEntry } from "./coordinator.js";

/** Per-project usage counters, accumulated locally and shipped to the calibration loop on sync. */
export interface UsageCounters {
  turns: number;
  decisions: number;
  recoveries: number;
  degraded: number;
  escalations: number;
  workerDeaths: number;
  quarantines: number;
  shieldBlocks: number;
  shieldEscalations: number;
  gatesGreen: number;
  gatesRed: number;
  routings: number;
  /** Every pre-flight inspection, whatever the verdict - the adoption signal for safety tooling. */
  shieldInspections: number;
  /** Every oversight trace evaluation. */
  oversightEvaluations: number;
  /** Coordination: presence reads, checkpoints, claims, and directive traffic (measured, never billed). */
  presenceChecks: number;
  /** Claims that discovered another agent already holding the same path - the collision signal. */
  claimConflicts: number;
  /** Directives issued to agents, and directives they acknowledged. */
  directivesIssued: number;
  directivesAcked: number;
}

export type UsageCounterName = keyof UsageCounters;

export function zeroUsage(): UsageCounters {
  return {
    turns: 0,
    decisions: 0,
    recoveries: 0,
    degraded: 0,
    escalations: 0,
    workerDeaths: 0,
    quarantines: 0,
    shieldBlocks: 0,
    shieldEscalations: 0,
    gatesGreen: 0,
    gatesRed: 0,
    routings: 0,
    shieldInspections: 0,
    oversightEvaluations: 0,
    presenceChecks: 0,
    claimConflicts: 0,
    directivesIssued: 0,
    directivesAcked: 0,
  };
}

/** On-disk shape of `.swarm-sentinel/memory.json`. */
export interface MemoryFile {
  version: 1;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  usage: UsageCounters;
  recentDecisions: DecisionLogEntry[];
  /** Calibration profile delivered by the server-side loop (thresholds, menu hints, …). */
  profile?: Record<string, unknown>;
  sync: { lastSyncedAt: number };
}

export interface ProjectMemoryOptions {
  /** Set false for "no memory": nothing is read, written, or synced. Default true. */
  enabled?: boolean;
  /** Defaults to `<cwd>/.swarm-sentinel/memory.json`. */
  path?: string;
  /** Cap on retained decision history (default 500). */
  maxDecisions?: number;
  /** Redaction applied before anything is written or synced (default: the telemetry scrubber). */
  scrubber?: (text: string) => string;
  /** Persist after every mutation (default true). Writes are serialized and never block callers. */
  autoPersist?: boolean;
}

export interface FailureLogEntry {
  action: string;
  jobId?: string;
  workerId?: string;
  error: string;
  timestamp: number;
}

export interface SyncPayload {
  version: 1;
  projectId: string;
  usage: UsageCounters;
  decisions?: DecisionLogEntry[];
  failures?: FailureLogEntry[];
  /** 16-hex SHA-256 digest of normalized `decisions` for server-side tamper detection. */
  decisionHash?: string;
  /** Client retention flags inspected by the server compliance gate. */
  zeroRetention?: boolean;
  telemetryEnabled?: boolean;
}

export interface SyncResponse {
  /** Calibration profile produced by the server-side loop. */
  profile?: Record<string, unknown>;
}

export interface SyncOptions {
  endpoint: string;
  apiKey?: string;
  /** Client fingerprint bound to the issued `ss_…` token (`x-sentinel-fingerprint`). */
  fingerprint?: string;
  /** Minimum time between syncs unless `force` (default 6 h). */
  intervalMs?: number;
  force?: boolean;
  /** Include recent (scrubbed) decisions in the payload. Default false: counters only. */
  includeDecisions?: boolean;
  /** Client retention flags forwarded to the control-plane compliance lock. */
  zeroRetention?: boolean;
  telemetryEnabled?: boolean;
  timeoutMs?: number;
  /** Transport override for testing or custom auth. Defaults to an HTTPS POST. */
  transport?: (payload: SyncPayload) => Promise<SyncResponse>;
}

export interface SyncResult {
  synced: boolean;
  reason?: string;
  profileUpdated?: boolean;
}

/** Billing-facing snapshot: counters plus the aggregate metered unit. */
export interface UsageReport {
  version: 1;
  projectId: string;
  exportedAt: number;
  window: { createdAt: number; updatedAt: number };
  counters: UsageCounters;
  /**
   * decisions + routings - the dispatch-class unit hosted tiers meter.
   * Safety checks (shield inspections, oversight evaluations) are measured in `counters` and
   * summarised in `safetyChecks`, deliberately NOT billed by default: pricing them would punish the
   * exact behaviour safety tooling should encourage.
   */
  billableDecisions: number;
  /** Aggregate safety-check volume: shieldInspections + oversightEvaluations. */
  safetyChecks: number;
  /**
   * Aggregate coordination volume: presence reads/checkpoints plus directive traffic. Like safety
   * checks, this is measured and deliberately outside the billable unit - it is the signal that tells
   * you whether the multi-agent habit is forming at all.
   */
  coordinationChecks: number;
}

interface ResolvedMemoryOptions {
  enabled: boolean;
  path: string;
  maxDecisions: number;
  scrubber: (text: string) => string;
  autoPersist: boolean;
}

const DEFAULT_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeUsage(value: unknown): UsageCounters {
  const usage = zeroUsage();
  if (value === null || typeof value !== "object") return usage;
  const entries = new Map(Object.entries(value));
  const names = Object.keys(usage) as UsageCounterName[]; // keys of a local UsageCounters literal
  for (const name of names) {
    const candidate = entries.get(name);
    if (typeof candidate === "number" && Number.isFinite(candidate)) usage[name] = candidate;
  }
  return usage;
}

function isDecisionEntry(value: unknown): value is DecisionLogEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    "action" in value &&
    typeof value.action === "string" &&
    "wave" in value &&
    typeof value.wave === "number"
  );
}

function normalizeFile(value: unknown): MemoryFile | undefined {
  if (value === null || typeof value !== "object" || !("version" in value) || value.version !== 1) {
    return undefined;
  }
  const now = Date.now();
  const sync = "sync" in value && value.sync !== null && typeof value.sync === "object" ? value.sync : undefined;
  const lastSyncedAt =
    sync && "lastSyncedAt" in sync && typeof sync.lastSyncedAt === "number" ? sync.lastSyncedAt : 0;
  const profile = "profile" in value && value.profile !== null && typeof value.profile === "object"
    ? Object.fromEntries(Object.entries(value.profile))
    : undefined;
  return {
    version: 1,
    projectId: "projectId" in value && typeof value.projectId === "string" ? value.projectId : crypto.randomUUID(),
    createdAt: "createdAt" in value && typeof value.createdAt === "number" ? value.createdAt : now,
    updatedAt: "updatedAt" in value && typeof value.updatedAt === "number" ? value.updatedAt : now,
    usage: normalizeUsage("usage" in value ? value.usage : undefined),
    recentDecisions:
      "recentDecisions" in value && Array.isArray(value.recentDecisions)
        ? value.recentDecisions.filter(isDecisionEntry)
        : [],
    profile,
    sync: { lastSyncedAt },
  };
}

function freshFile(): MemoryFile {
  const now = Date.now();
  return {
    version: 1,
    projectId: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    usage: zeroUsage(),
    recentDecisions: [],
    sync: { lastSyncedAt: 0 },
  };
}

function hashSyncDecisions(decisions: DecisionLogEntry[]): string {
  const normalized = decisions.map((entry) => ({
    wave: entry.wave,
    action: entry.action,
    jobId: entry.jobId,
    workerId: entry.workerId,
    isRecovery: entry.isRecovery,
    fallback: entry.fallback ?? false,
    degraded: entry.degraded ?? false,
    fallbackReason: entry.fallbackReason,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

async function defaultSyncTransport(payload: SyncPayload, options: SyncOptions): Promise<SyncResponse> {
  const url = new URL(options.endpoint);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Insecure calibration sync endpoint: "${options.endpoint}". Production sync requires HTTPS.`);
  }
  const response = await fetch(options.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      ...(options.fingerprint ? { "x-sentinel-fingerprint": options.fingerprint } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const errBody = (await response.json()) as { error?: unknown; reason?: unknown };
      if (typeof errBody?.reason === "string") detail = `: ${errBody.reason}`;
      else if (typeof errBody?.error === "string") detail = `: ${errBody.error}`;
    } catch {
      // Ignore non-JSON error body.
    }
    throw new Error(`calibration sync failed with HTTP ${response.status}${detail}`);
  }
  const body: unknown = await response.json();
  if (body !== null && typeof body === "object" && "profile" in body && body.profile !== null && typeof body.profile === "object") {
    return { profile: Object.fromEntries(Object.entries(body.profile)) };
  }
  return {};
}

/**
 * Client-side project memory: a small JSON file under `.swarm-sentinel/` that survives runs,
 * accumulates usage counters, keeps a bounded decision history, and carries the calibration
 * profile pulled from the server-side loop.
 *
 * Local-first by design: nothing leaves the machine unless `sync()` is called with an endpoint.
 * Set `enabled: false` for a completely memoryless client.
 */
export class ProjectMemory {
  private file: MemoryFile;
  private options: ResolvedMemoryOptions;
  private writeChain: Promise<void> = Promise.resolve();
  private ignoreFileEnsured = false;
  public lastWriteError?: Error;
  public readonly recoveredFromCorrupt: boolean;
  private failures: FailureLogEntry[] = [];

  private constructor(file: MemoryFile, options: ResolvedMemoryOptions, recoveredFromCorrupt: boolean) {
    this.file = file;
    this.options = options;
    this.recoveredFromCorrupt = recoveredFromCorrupt;
  }

  /** Opens (or creates) the project memory file. Corrupt files are quarantined, never fatal. */
  public static async open(options: ProjectMemoryOptions = {}): Promise<ProjectMemory> {
    const resolved: ResolvedMemoryOptions = {
      enabled: options.enabled ?? true,
      path: options.path ?? path.join(process.cwd(), ".swarm-sentinel", "memory.json"),
      maxDecisions: options.maxDecisions ?? 500,
      scrubber: options.scrubber ?? scrubSecrets,
      autoPersist: options.autoPersist ?? true,
    };

    let file: MemoryFile | undefined;
    let recoveredFromCorrupt = false;

    if (resolved.enabled) {
      let raw: string | undefined;
      try {
        raw = await fs.readFile(resolved.path, "utf8");
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
      if (raw !== undefined) {
        try {
          file = normalizeFile(JSON.parse(raw));
        } catch {
          file = undefined;
        }
        if (!file) {
          recoveredFromCorrupt = true;
          await fs.rename(resolved.path, `${resolved.path}.corrupt-${Date.now()}`).catch(() => undefined);
        }
      }
    }

    const memory = new ProjectMemory(file ?? freshFile(), resolved, recoveredFromCorrupt);
    if (resolved.enabled && !file) {
      try {
        await memory.persistNow();
      } catch (error) {
        // Memory is best-effort: a read-only disk must not stop the run.
        memory.lastWriteError = error instanceof Error ? error : new Error(String(error));
      }
    }
    return memory;
  }

  public get enabled(): boolean {
    return this.options.enabled;
  }

  public get projectId(): string {
    return this.file.projectId;
  }

  public get filePath(): string {
    return this.options.path;
  }

  /** Copy of the current usage counters. */
  public get usage(): UsageCounters {
    return { ...this.file.usage };
  }

  public getRecentDecisions(): DecisionLogEntry[] {
    return this.file.recentDecisions.map((entry) => ({ ...entry }));
  }

  public getProfile(): Record<string, unknown> | undefined {
    return this.file.profile ? { ...this.file.profile } : undefined;
  }

  /** Billing-friendly snapshot of the counters (cumulative since the last `resetUsage()`). */
  public getUsageReport(): UsageReport {
    const counters = this.usage;
    return {
      version: 1,
      projectId: this.file.projectId,
      exportedAt: Date.now(),
      window: { createdAt: this.file.createdAt, updatedAt: this.file.updatedAt },
      counters,
      billableDecisions: counters.decisions + counters.routings,
      safetyChecks: counters.shieldInspections + counters.oversightEvaluations,
      coordinationChecks: counters.presenceChecks + counters.directivesIssued + counters.directivesAcked,
    };
  }

  /** The usage report as a header + single CSV row, ready for billing ingestion. */
  public usageReportCsv(): string {
    const report = this.getUsageReport();
    const fields = Object.keys(report.counters) as UsageCounterName[];
    const header = ["projectId", "exportedAt", "windowFrom", "windowTo", ...fields, "billableDecisions", "safetyChecks", "coordinationChecks"].join(",");
    const values: Array<string | number> = [
      report.projectId,
      report.exportedAt,
      report.window.createdAt,
      report.window.updatedAt,
      ...fields.map((field) => report.counters[field]),
      report.billableDecisions,
      report.safetyChecks,
      report.coordinationChecks,
    ];
    return `${header}\n${values.join(",")}\n`;
  }

  /** Zeroes the counters for period billing; the profile and decision history are preserved. */
  public resetUsage(): void {
    if (!this.options.enabled) return;
    this.file.usage = zeroUsage();
    this.schedulePersist();
  }

  public setProfile(profile: Record<string, unknown>): void {
    if (!this.options.enabled || !profile || typeof profile !== "object") return;
    this.file.profile = { ...profile };
    this.schedulePersist();
  }

  public increment(field: UsageCounterName, by = 1): void {
    if (!this.options.enabled) return;
    if (typeof by !== "number" || !Number.isFinite(by) || by < 0) return;
    if (!(field in this.file.usage)) return;
    this.file.usage[field] += by;
    this.schedulePersist();
  }

  /** Appends a scrubbed decision to the bounded history. */
  public recordDecision(entry: DecisionLogEntry): void {
    if (!this.options.enabled) return;
    this.file.recentDecisions.push({
      ...entry,
      action: this.options.scrubber(entry.action),
      jobId: entry.jobId === undefined ? undefined : this.options.scrubber(entry.jobId),
      workerId: entry.workerId === undefined ? undefined : this.options.scrubber(entry.workerId),
      error: entry.error === undefined ? undefined : this.options.scrubber(entry.error),
    });
    if (this.file.recentDecisions.length > this.options.maxDecisions) {
      this.file.recentDecisions.splice(0, this.file.recentDecisions.length - this.options.maxDecisions);
    }
    this.schedulePersist();
  }

  public recordFailure(entry: FailureLogEntry): void {
    if (!this.options.enabled) return;
    this.failures.push({
      action: this.options.scrubber(entry.action),
      jobId: entry.jobId === undefined ? undefined : this.options.scrubber(entry.jobId),
      workerId: entry.workerId === undefined ? undefined : this.options.scrubber(entry.workerId),
      error: this.options.scrubber(entry.error),
      timestamp: entry.timestamp,
    });
    if (this.failures.length > this.options.maxDecisions) {
      this.failures.splice(0, this.failures.length - this.options.maxDecisions);
    }
  }

  public needsSync(intervalMs = DEFAULT_SYNC_INTERVAL_MS, now = Date.now()): boolean {
    return now - this.file.sync.lastSyncedAt >= intervalMs;
  }

  /**
   * Pushes usage counters (and optionally the scrubbed decision history) to the calibration
   * endpoint and applies any returned profile. Fails soft: the result says why nothing was sent.
   */
  public async sync(options: SyncOptions): Promise<SyncResult> {
    if (!this.options.enabled) {
      return { synced: false, reason: "memory disabled" };
    }
    if (!options.force && !this.needsSync(options.intervalMs)) {
      return { synced: false, reason: "sync interval not elapsed" };
    }

    const decisions = options.includeDecisions ? this.getRecentDecisions() : undefined;
    const failures = options.includeDecisions && this.failures.length > 0 ? [...this.failures] : undefined;
    const payload: SyncPayload = {
      version: 1,
      projectId: this.file.projectId,
      usage: this.usage,
      ...(decisions ? { decisions, decisionHash: hashSyncDecisions(decisions) } : {}),
      ...(failures ? { failures } : {}),
      ...(options.zeroRetention !== undefined ? { zeroRetention: options.zeroRetention } : {}),
      ...(options.telemetryEnabled !== undefined ? { telemetryEnabled: options.telemetryEnabled } : {}),
    };
    try {
      const response = options.transport
        ? await options.transport(payload)
        : await defaultSyncTransport(payload, options);
      if (response.profile) {
        this.setProfile(response.profile);
      }
      this.file.sync.lastSyncedAt = Date.now();
      this.schedulePersist();
      return { synced: true, profileUpdated: Boolean(response.profile) };
    } catch (error) {
      return { synced: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Automatic session-lease handshake when `SENTINEL_CONTROL_PLANE_URL` (or `SENTINEL_SYNC_URL`)
   * and `SENTINEL_TOKEN` are present in the environment. Exchanges scrubbed usage + decision hash
   * for the tenant's latest CalibrationProfile and menuHints.
   */
  public async autoSyncFromEnv(env: NodeJS.ProcessEnv = process.env, force = false): Promise<SyncResult | null> {
    const rawUrl = env.SENTINEL_CONTROL_PLANE_URL || env.SENTINEL_SYNC_URL;
    const token = env.SENTINEL_TOKEN;
    if (!rawUrl || !token) return null;
    const trimmed = rawUrl.trim().replace(/\/+$/, "");
    const endpoint = trimmed.endsWith("/v1/sync") ? trimmed : `${trimmed}/v1/sync`;
    const zeroRetention =
      env.SWARM_SENTINEL_ZERO_RETENTION === "1" || env.SWARM_SENTINEL_ZERO_RETENTION === "true";
    const telemetryEnabled =
      env.SWARM_SENTINEL_TELEMETRY_DISABLED === "1" || env.SWARM_SENTINEL_TELEMETRY_DISABLED === "true"
        ? false
        : undefined;
    return this.sync({
      endpoint,
      apiKey: token.trim(),
      fingerprint: env.SENTINEL_FINGERPRINT?.trim(),
      includeDecisions: true,
      force,
      ...(zeroRetention ? { zeroRetention: true } : {}),
      ...(telemetryEnabled === false ? { telemetryEnabled: false } : {}),
    });
  }

  /** Resolves once every scheduled write has hit disk. */
  public async flush(): Promise<void> {
    await this.writeChain;
  }

  public snapshot(): MemoryFile {
    return {
      ...this.file,
      usage: { ...this.file.usage },
      recentDecisions: this.getRecentDecisions(),
      sync: { ...this.file.sync },
      profile: this.getProfile(),
    };
  }

  private schedulePersist(): void {
    if (!this.options.enabled || !this.options.autoPersist) return;
    this.writeChain = this.writeChain
      .then(() => this.persistNow())
      .then(
        () => undefined,
        (error: unknown) => {
          this.lastWriteError = error instanceof Error ? error : new Error(String(error));
        }
      );
  }

  private async persistNow(): Promise<void> {
    const directory = path.dirname(this.options.path);
    await fs.mkdir(directory, { recursive: true });

    if (!this.ignoreFileEnsured) {
      // Keep the memory out of version control by default: a self-ignoring directory.
      await fs.writeFile(path.join(directory, ".gitignore"), "*\n", { flag: "wx" }).catch(() => undefined);
      this.ignoreFileEnsured = true;
    }

    this.file.updatedAt = Date.now();
    const temporaryPath = `${this.options.path}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.options.path);
  }
}
