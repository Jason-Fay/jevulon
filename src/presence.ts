/**
 * Presence board: the shared, durable medium for agents that never talk to each other.
 *
 * The blackboard's stigmergy assumed one process. This is the same substrate across processes: claims
 * (who is in which file, why, until when), pheromone trails with wall-clock decay, and a bounded event
 * log carrying who/when/what/why. It is **advisory**: nothing here gates a safety decision, the shield
 * floor stays authoritative, and a stale record must expire rather than wedge a repository.
 *
 * Storage: one JSON document under the repository's git common dir (`<common>/swarm-sentinel/board.json`)
 * so every worktree of one project shares it; falls back to `<cwd>/.swarm-sentinel/board.json` outside a
 * repository. The bytes live behind the `StateStore` seam (`src/state-store.ts`): cross-process-locked
 * JSON (default) or SQLite, selected by `SWARM_SENTINEL_STATE_STORE=file|sqlite`. One writer at a time  - 
 * and a writer that crashes cannot wedge the board: the file lock expires and is taken over, SQLite
 * rolls the half-written transaction back. No call site changes with the store.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { createStateStore } from "./state-store.js";
import type { StateStore } from "./state-store.js";

/**
 * Object.prototype reach-through names: never acceptable as caller-supplied keys in a board map.
 * `"__proto__"` is computed on purpose - a literal `__proto__:` entry would set the prototype instead of
 * defining the plain own key this table needs. `boolean` (not `true`) because TypeScript widens the
 * literal at the `constructor` key against a literal-valued index signature.
 */
const UNSAFE_KEYS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

/** Raised when a caller-supplied id would reach through Object.prototype in a board map. */
export class UnsafeBoardKeyError extends Error {
  constructor(
    public readonly kind: string,
    public readonly key: string
  ) {
    super(`Unsafe board ${kind} "${key}" - "__proto__", "constructor" and "prototype" are rejected.`);
    this.name = "UnsafeBoardKeyError";
  }
}

/** Raised when a directive id is unknown, expired out, or dropped by a concurrent trim before the write lands. */
export class DirectiveNotFoundError extends Error {
  constructor(public readonly directiveId: string) {
    super(`Directive "${directiveId}" not found (expired?).`);
    this.name = "DirectiveNotFoundError";
  }
}

/** Raised when one signal value is too large for the shared board. */
export class SignalValueTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly maxBytes: number
  ) {
    super(`Signal value is ${bytes} bytes; the board caps one value at ${maxBytes} bytes.`);
    this.name = "SignalValueTooLargeError";
  }
}

/** Boundary guard: caller ids that could reach through Object.prototype are rejected before any map is touched. */
function assertSafeKey(kind: string, key: string): void {
  if (UNSAFE_KEYS[key] === true) throw new UnsafeBoardKeyError(kind, key);
}

export interface AgentRecord {
  id: string;
  kind: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  /** When this agent last took a checkpoint - how "what changed since I last looked" is answered. */
  seenAt?: number;
}

export interface ClaimRecord {
  path: string;
  agentId: string;
  mode: "edit" | "read";
  /** Why the agent is in this file - the half of the handoff that tokens usually pay for. */
  note?: string;
  since: number;
  expiresAt: number;
}

export interface TrailRecord {
  count: number;
  lastAt: number;
  note?: string;
}

export interface BoardEvent {
  at: number;
  type: "claim" | "release" | "alarm" | "attractant" | "heartbeat" | "expiry" | "note" | "directive" | "ack" | "resolve" | "thrash_suppressed";
  actor: string;
  detail: string;
  rationale?: string;
}

export type DirectiveKind = "pause" | "reprioritize" | "abandon" | "handoff";


export interface ConditionalInstruction {
  match: string;
  sensitivity: "open" | "standard" | "restricted";
  instruction: string;
  source: "file" | "signal" | "builtin";
}
/**
 * An instruction addressed to one agent, delivered at its next checkpoint. Advisory at the task layer:
 * the agent acknowledges it and acts on its own terms; it never loosens the shield floor, and it dies if
 * nobody acts (so a stale directive cannot steer anything).
 */
export interface DirectiveRecord {
  id: string;
  agentId: string;
  kind: DirectiveKind;
  /** What the directive is about: a path, a job id, or a short target description. */
  target: string;
  issuedBy: string;
  rationale?: string;
  createdAt: number;
  expiresAt: number;
  ack?: { at: number; by: string; note?: string };
  resolvedAt?: number;
}

export interface SignalRecord {
  key: string;
  value: unknown;
  author: string;
  updatedAt: number;
  expiresAt?: number;
}

export interface PresenceDocument {
  version: 1;
  agents: Record<string, AgentRecord>;
  claims: Record<string, ClaimRecord>;
  alarms: Record<string, TrailRecord>;
  attractants: Record<string, TrailRecord>;
  events: BoardEvent[];
  directives: Record<string, DirectiveRecord>;
  signals?: Record<string, SignalRecord>;
}

export interface PresenceOptions {
  /** Explicit board file; otherwise resolved from the environment or the repository layout. */
  path?: string;
  /** Explicit state-store seam (tests, exotic backends); otherwise built from `SWARM_SENTINEL_STATE_STORE`. */
  store?: StateStore;
  /** Heartbeat horizon: an agent silent for longer than this is no longer "alive". */
  agentTtlMs?: number;
  /** Dead-agent records are dropped once silent this long - "who was here" outlives the aliveness horizon. */
  staleAgentMs?: number;
  /** Default claim lifetime. */
  claimTtlMs?: number;
  /** Decay constant for pheromone trails (effective value halves every ~0.69·tau). */
  decayTauMs?: number;
  maxEvents?: number;
  /** Cap per pheromone field (alarms / attractants): the lowest-count entry is evicted at the boundary. */
  maxTrailEntries?: number;
  /** Cap on stored signals: the stalest-updated entry is evicted at the boundary. */
  maxSignalEntries?: number;
  /** Default signal lifetime (15 min). Durable findings (`gap/*`) override per signal via `ttlMs` instead of re-signalling. */
  signalTtlMs?: number;
  /** Default directive lifetime: a directive nobody acts on expires. */
  directiveTtlMs?: number;
  /** Thrash control: at most this many directives per (agent, target) inside `thrashWindowMs`. */
  maxDirectivesPerTarget?: number;
  thrashWindowMs?: number;
}

const DEFAULTS = {
  agentTtlMs: 2 * 60 * 1000,
  claimTtlMs: 15 * 60 * 1000,
  staleAgentMs: 30 * 60 * 1000,
  decayTauMs: 30 * 60 * 1000,
  maxEvents: 500,
  maxTrailEntries: 1000,
  maxSignalEntries: 1000,
  signalTtlMs: 15 * 60 * 1000,
  directiveTtlMs: 10 * 60 * 1000,
  maxDirectivesPerTarget: 3,
  thrashWindowMs: 10 * 60 * 1000,
};

/** One signal value is a shared-board record, not a payload bus. */
const MAX_SIGNAL_VALUE_BYTES = 8 * 1024;

/** `<repo>/.git` common dir when inside a repository, so worktrees share one board. */
export function resolveBoardPath(cwd = process.cwd()): string {
  if (process.env.JEVULON_BOARD) return process.env.JEVULON_BOARD;
  if (process.env.SWARM_SENTINEL_BOARD) return process.env.SWARM_SENTINEL_BOARD;
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (commonDir) {
      const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
      const jevPath = path.join(absolute, "jevulon", "board.json");
      const sentinelPath = path.join(absolute, "swarm-sentinel", "board.json");
      if (fs.existsSync(sentinelPath) && !fs.existsSync(jevPath)) return sentinelPath;
      return jevPath;
    }
  } catch {
    // Not a repository (or git unavailable): fall back to the working directory.
  }
  const localJev = path.join(cwd, ".jevulon", "board.json");
  const localSentinel = path.join(cwd, ".swarm-sentinel", "board.json");
  if (fs.existsSync(localSentinel) && !fs.existsSync(localJev)) return localSentinel;
  return localJev;
}

/**
 * One vocabulary for claims across every read - the MCP boundary must not expose two shapes for the same
 * record. `agentId` is the record; `heldBy` reads better on a conflict (whose is it).
 */
function shapeClaim(record: ClaimRecord) {
  return {
    path: record.path,
    agentId: record.agentId,
    mode: record.mode,
    ...(record.note === undefined ? {} : { why: record.note }),
    since: record.since,
    expiresAt: record.expiresAt,
  };
}

function shapeConflict(record: ClaimRecord) {
  return {
    path: record.path,
    heldBy: record.agentId,
    mode: record.mode,
    ...(record.note === undefined ? {} : { why: record.note }),
  };
}

/**
 * The claim contention matrix: only edit-vs-edit contends. A read claim is an observer - its overlap
 * with an edit claim is informational, never a conflict.
 */
const CLAIM_CONTENTION: Record<ClaimRecord["mode"], Record<ClaimRecord["mode"], boolean>> = {
  edit: { edit: true, read: false },
  read: { edit: false, read: false },
};

/** One sentence per contention outcome - the same vocabulary as the MCP claim response `summary`. */
function claimSummary(conflicts: ClaimRecord[], observers: ClaimRecord[]): string {
  if (conflicts.length > 0) return "another agent holds some of these paths - coordinate before editing";
  if (observers.length > 0) {
    return `informational overlap: ${observers.map((record) => `${record.agentId} ${record.mode} ${record.path}`).join(", ")} - a read claim is an observer, not a conflict`;
  }
  return "no other agent holds these paths";
}

/**
 * Board maps are null-prototype: a caller key like `__proto__` becomes a plain entry instead of reaching
 * through Object.prototype (which the boundary guard rejects anyway - belt and braces).
 */
function safeRecord<T>(): Record<string, T> {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
}

/** Rebuilds a map from a parsed board: own entries only, unsafe names dropped, never the parser's prototype. */
function copySafe<T>(source: Record<string, T> | undefined): Record<string, T> {
  const target = safeRecord<T>();
  if (source === undefined) return target;
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS[key] === true) continue;
    target[key] = value;
  }
  return target;
}

export class PresenceBoard {
  private readonly filePath: string;
  private readonly store: StateStore;
  private readonly agentTtlMs: number;
  private readonly staleAgentMs: number;
  private readonly claimTtlMs: number;
  private readonly decayTauMs: number;
  private readonly maxEvents: number;
  private readonly maxTrailEntries: number;
  private readonly maxSignalEntries: number;
  private readonly signalTtlMs: number;
  private readonly directiveTtlMs: number;
  private readonly maxDirectivesPerTarget: number;
  private readonly thrashWindowMs: number;

  constructor(options: PresenceOptions = {}) {
    this.filePath = options.path ?? resolveBoardPath();
    this.store = options.store ?? createStateStore(this.filePath);
    this.agentTtlMs = options.agentTtlMs ?? DEFAULTS.agentTtlMs;
    this.staleAgentMs = options.staleAgentMs ?? DEFAULTS.staleAgentMs;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULTS.claimTtlMs;
    this.decayTauMs = options.decayTauMs ?? DEFAULTS.decayTauMs;
    this.maxEvents = options.maxEvents ?? DEFAULTS.maxEvents;
    this.maxTrailEntries = options.maxTrailEntries ?? DEFAULTS.maxTrailEntries;
    this.maxSignalEntries = options.maxSignalEntries ?? DEFAULTS.maxSignalEntries;
    this.signalTtlMs = options.signalTtlMs ?? DEFAULTS.signalTtlMs;
    this.directiveTtlMs = options.directiveTtlMs ?? DEFAULTS.directiveTtlMs;
    this.maxDirectivesPerTarget = options.maxDirectivesPerTarget ?? DEFAULTS.maxDirectivesPerTarget;
    this.thrashWindowMs = options.thrashWindowMs ?? DEFAULTS.thrashWindowMs;
  }

  public get path(): string {
    return this.filePath;
  }

  // ---- storage (the bytes and the one-writer serialisation live behind the StateStore seam) ----

  /** Rebuilds a board document from persisted state: own entries only, unsafe names dropped, never the parser's prototype. */
  private hydrate(parsed: unknown): PresenceDocument {
    const source = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Partial<PresenceDocument>;
    return {
      version: 1,
      agents: copySafe(source.agents),
      claims: copySafe(source.claims),
      alarms: copySafe(source.alarms),
      attractants: copySafe(source.attractants),
      events: Array.isArray(source.events) ? source.events : [],
      directives: copySafe(source.directives),
      signals: copySafe(source.signals),
    };
  }

  /** Reads the document. Only a missing store is an empty board; anything unreadable surfaces. */
  public read(): PresenceDocument {
    return this.hydrate(this.store.load());
  }

  /**
   * Read-modify-write serialised by the state store: one writer at a time, so `change` always meets the
   * newest document. `change` returns `false` for "nothing to write"; any other value marks the document
   * dirty and is handed back from the attempt whose write actually landed - a discarded retry's value
   * never escapes, so allocate()/release() cannot report a take or a drop that did not happen.
   */
  public mutate<T>(change: (document: PresenceDocument) => T | false, now = Date.now()): T | false {
    return this.store.update((current) => {
      const document = this.hydrate(current);
      const pruned = this.prune(document, now);
      const outcome = change(document);
      if (outcome === false && !pruned) return false;
      return { next: document, result: outcome };
    });
  }

  /** Housekeeping inside every mutation: expired claims and long-dead agents leave no residue. */
  private prune(document: PresenceDocument, now: number): boolean {
    let pruned = false;
    for (const [key, record] of Object.entries(document.claims)) {
      if (record.expiresAt <= now) {
        delete document.claims[key];
        pruned = true;
      }
    }
    for (const [id, agent] of Object.entries(document.agents)) {
      if (now - agent.heartbeatAt > this.staleAgentMs) {
        delete document.agents[id];
        pruned = true;
      }
    }
    return pruned;
  }

  // ---- agents ----

  public registerAgent(id: string, kind = "agent", now = Date.now()): void {
    assertSafeKey("agent id", id);
    this.mutate((document) => {
      const existing = document.agents[id];
      document.agents[id] = {
        id,
        kind,
        pid: process.pid,
        startedAt: existing?.startedAt ?? now,
        heartbeatAt: now,
      };
      return true;
    }, now);
  }

  /** Records liveness. Cheap enough to call on every tool boundary. */
  public heartbeat(id: string, now = Date.now()): void {
    assertSafeKey("agent id", id);
    this.mutate((document) => {
      const agent = document.agents[id];
      if (agent) agent.heartbeatAt = now;
      else document.agents[id] = { id, kind: "agent", pid: process.pid, startedAt: now, heartbeatAt: now };
      return true;
    }, now);
  }

  public aliveAgents(now = Date.now()): AgentRecord[] {
    const document = this.read();
    return Object.values(document.agents)
      .filter((agent) => now - agent.heartbeatAt <= this.agentTtlMs)
      .sort((left, right) => right.heartbeatAt - left.heartbeatAt);
  }

  // ---- claims ----

  public claim(
    agentId: string,
    paths: string[],
    options: { mode?: "edit" | "read"; note?: string; ttlMs?: number } = {},
    now = Date.now()
  ): ClaimRecord[] {
    assertSafeKey("agent id", agentId);
    const unique = [...new Set(paths.filter((entry) => entry && entry.trim().length > 0))];
    const ttlMs = options.ttlMs ?? this.claimTtlMs;
    const records: ClaimRecord[] = unique.map((entry) => ({
      path: entry,
      agentId,
      mode: options.mode ?? "edit",
      ...(options.note === undefined ? {} : { note: options.note }),
      since: now,
      expiresAt: now + ttlMs,
    }));

    this.mutate((document) => {
      for (const record of records) {
        document.claims[`${record.agentId}::${record.path}`] = record;
        document.events.push({
          at: now,
          type: "claim",
          actor: agentId,
          detail: `${record.mode} ${record.path}`,
          ...(record.note === undefined ? {} : { rationale: record.note }),
        });
      }
      this.trimEvents(document);
      return true;
    }, now);
    return records;
  }

  /**
   * Atomically take the next unallocated item from a named queue. Returns null when the queue is exhausted.
   *
   * The board ANNOUNCES with claim() and that is not enough: four fast workers all pass a conflicts() check
   * before any claim lands (measured: 64 audits for a 24-item pool, 88% duplicated). Allocation must be a single
   * operation - choosing the item and recording its owner happen inside mutate()'s serialised read-modify-write.
   */
  public allocate(agentId: string, queueKey: string, items: string[], now = Date.now()): string | null {
    assertSafeKey("agent id", agentId);
    // The outcome comes from the attempt whose write landed: a discarded retry that believed it took an
    // item must never hand that item to this caller as well.
    const taken = this.mutate((document) => {
      const live = new Set(Object.values(document.claims).filter((record) => record.expiresAt > now).map((record) => record.path));
      const next = items.find((item) => !live.has(`queue:${queueKey}:${item}`) && !live.has(`done:${queueKey}:${item}`));
      if (next === undefined) return false;
      const path = `queue:${queueKey}:${next}`;
      document.claims[`${agentId}::${path}`] = { path, agentId, mode: "edit", since: now, expiresAt: now + this.claimTtlMs };
      document.events.push({ at: now, type: "claim", actor: agentId, detail: path });
      this.trimEvents(document);
      return next;
    }, now);
    return taken === false ? null : taken;
  }

  /** Releases the agent's claims (all of them when `paths` is omitted); returns how many were dropped. */
  public release(agentId: string, paths?: string[], now = Date.now()): number {
    assertSafeKey("agent id", agentId);
    const released = this.mutate((document) => {
      let dropped = 0;
      for (const [key, record] of Object.entries(document.claims)) {
        if (record.agentId !== agentId) continue;
        if (paths && !paths.includes(record.path)) continue;
        delete document.claims[key];
        document.events.push({ at: now, type: "release", actor: agentId, detail: record.path });
        dropped++;
      }
      this.trimEvents(document);
      return dropped === 0 ? false : dropped;
    }, now);
    return released === false ? 0 : released;
  }

  /** Live claims, optionally narrowed to one agent. Expired claims are dropped. */
  public claims(filter: { agentId?: string; paths?: string[] } = {}, now = Date.now()): ClaimRecord[] {
    const document = this.read();
    return Object.values(document.claims)
      .filter((record) => record.expiresAt > now)
      .filter((record) => filter.agentId === undefined || record.agentId === filter.agentId)
      .filter((record) => filter.paths === undefined || filter.paths.includes(record.path));
  }

  /**
   * Claims held by *other* agents over the given paths that contend with a claim in `mode` - the
   * collision signal is edit-vs-edit only; a read claim is an observer and never conflicts.
   */
  public conflicts(agentId: string, paths: string[], mode: ClaimRecord["mode"] = "edit", now = Date.now()): ClaimRecord[] {
    return this.claims({ paths }, now).filter((record) => record.agentId !== agentId && CLAIM_CONTENTION[mode][record.mode]);
  }

  // ---- pheromone trails (wall-clock decay, computed on read) ----

  public depositAlarm(key: string, note?: string, now = Date.now()): void {
    this.deposit("alarms", key, note, now);
  }

  public depositAttractant(key: string, note?: string, now = Date.now()): void {
    this.deposit("attractants", key, note, now);
  }

  private deposit(field: "alarms" | "attractants", key: string, note: string | undefined, now: number): void {
    if (!key || typeof key !== "string") return;
    assertSafeKey("trail key", key);
    this.mutate((document) => {
      const trail = document[field];
      const current = trail[key];
      // Bounded like PheromoneField: at the cap, a new key evicts the lowest-count entry.
      const entries = Object.entries(trail);
      if (current === undefined && entries.length > 0 && entries.length >= this.maxTrailEntries) {
        const [lowestKey] = entries.reduce((lowest, entry) => (entry[1].count < lowest[1].count ? entry : lowest));
        delete trail[lowestKey];
      }
      trail[key] = { count: (current?.count ?? 0) + 1, lastAt: now, ...(note === undefined && current?.note === undefined ? {} : { note: note ?? current?.note }) };
      document.events.push({ at: now, type: field === "alarms" ? "alarm" : "attractant", actor: "agent", detail: key, ...(note === undefined ? {} : { rationale: note }) });
      this.trimEvents(document);
      return true;
    }, now);
  }

  /** Effective alarm strength: deposits decay with wall-clock time, so no daemon is needed. */
  // (Read through `presence().hot` / `presence().attracting`; a per-key accessor is added when a caller needs one.)

  // ---- events ----

  public recentEvents(limit = 20): BoardEvent[] {
    return this.read().events.slice(-limit).reverse();
  }

  public note(actor: string, detail: string, rationale?: string, now = Date.now()): void {
    this.mutate((document) => {
      document.events.push({ at: now, type: "note", actor, detail, ...(rationale === undefined ? {} : { rationale }) });
      this.trimEvents(document);
      return true;
    }, now);
  }

  private trimEvents(document: PresenceDocument): void {
    if (document.events.length > this.maxEvents) {
      document.events.splice(0, document.events.length - this.maxEvents);
    }
  }

  // ---- signals: shared contracts and environmental state ----

  /**
   * Posts or updates a named signal on the board (e.g. style_contract, shared_tokens, review_status).
   * Persists on the board and is delivered to all agents via checkpoint / presence read.
   * Lifetime policy: `ttlMs` overrides the default (`signalTtlMs`, 15 minutes) - durable findings
   * (`gap/*`) ask for the hours they need instead of re-signalling.
   */
  public signal(
    key: string,
    value: unknown,
    author: string,
    options: { ttlMs?: number; now?: number } = {}
  ): SignalRecord {
    if (!key || typeof key !== "string" || key.length > 256) {
      throw new Error(`Invalid signal key: "${key}"`);
    }
    assertSafeKey("signal key", key);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized ?? "", "utf-8");
    if (bytes > MAX_SIGNAL_VALUE_BYTES) throw new SignalValueTooLargeError(bytes, MAX_SIGNAL_VALUE_BYTES);
    const now = options.now ?? Date.now();
    const ttlMs = options.ttlMs ?? this.signalTtlMs;
    const record: SignalRecord = {
      key,
      value,
      author,
      updatedAt: now,
      expiresAt: now + ttlMs,
    };
    this.mutate((document) => {
      document.signals ??= safeRecord<SignalRecord>();
      const signals = document.signals;
      // Bounded like PheromoneField: at the cap, a new key evicts the stalest-updated entry.
      const entries = Object.entries(signals);
      if (signals[key] === undefined && entries.length > 0 && entries.length >= this.maxSignalEntries) {
        const [stalestKey] = entries.reduce((oldest, entry) => (entry[1].updatedAt < oldest[1].updatedAt ? entry : oldest));
        delete signals[stalestKey];
      }
      signals[key] = record;
      document.events.push({
        at: now,
        type: "note",
        actor: author,
        detail: `signal:${key}`,
        rationale: serialized,
      });
      this.trimEvents(document);
      return true;
    }, now);
    return record;
  }

  /** Active signals on the board, dropping expired ones. */
  public signals(filter: { key?: string; author?: string } = {}, now = Date.now()): SignalRecord[] {
    const document = this.read();
    const all = Object.values(document.signals ?? {});
    return all
      .filter((record) => record.expiresAt === undefined || record.expiresAt > now)
      .filter((record) => filter.key === undefined || record.key === filter.key)
      .filter((record) => filter.author === undefined || record.author === filter.author);
  }

  // ---- directives: steering a live agent at its next checkpoint ----

  /**
   * Issues a directive to one agent. Refused (and logged) past the thrash cap for that (agent, target)
   * pair inside the window: repeated re-steering is the failure mode that makes a swarm oscillate, so the
   * governor is part of the API rather than a convention.
   */
  public direct(
    agentId: string,
    instruction: { kind: DirectiveKind; target: string; issuedBy: string; rationale?: string; ttlMs?: number },
    now = Date.now()
  ): { refused: false; directive: DirectiveRecord } | { refused: true; reason: string } {
    assertSafeKey("agent id", agentId);
    const recent = Object.values(this.read().directives).filter(
      (record) => record.agentId === agentId && record.target === instruction.target && now - record.createdAt <= this.thrashWindowMs
    );
    if (recent.length >= this.maxDirectivesPerTarget) {
      this.note(
        instruction.issuedBy,
        `thrash suppressed for ${agentId} on ${instruction.target} (${recent.length} directives in ${Math.round(this.thrashWindowMs / 1000)}s)`,
        instruction.rationale,
        now
      );
      return { refused: true, reason: `${recent.length} directives already issued for this target inside the window - let the agent act before re-steering` };
    }

    const directive: DirectiveRecord = {
      id: `dir_${crypto.randomBytes(6).toString("hex")}`,
      agentId,
      kind: instruction.kind,
      target: instruction.target,
      issuedBy: instruction.issuedBy,
      ...(instruction.rationale === undefined ? {} : { rationale: instruction.rationale }),
      createdAt: now,
      expiresAt: now + (instruction.ttlMs ?? this.directiveTtlMs),
    };

    this.mutate((document) => {
      document.directives[directive.id] = directive;
      document.events.push({
        at: now,
        type: "directive",
        actor: instruction.issuedBy,
        detail: `${directive.kind} ${directive.target} → ${agentId}`,
        ...(directive.rationale === undefined ? {} : { rationale: directive.rationale }),
      });
      this.trimDirectives(document, now);
      this.trimEvents(document);
      return true;
    }, now);
    return { refused: false, directive };
  }

  /** Live directives addressed to one agent - what its next checkpoint should surface. */
  public directives(agentId: string, now = Date.now()): DirectiveRecord[] {
    return Object.values(this.read().directives)
      .filter((record) => record.agentId === agentId && record.resolvedAt === undefined && record.expiresAt > now)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Records that the agent saw the directive. Acknowledging an expired directive is an error, not a no-op. */
  public acknowledge(id: string, by: string, note?: string, now = Date.now()): DirectiveRecord {
    assertSafeKey("directive id", id);
    const existing = this.read().directives[id];
    if (!existing) throw new DirectiveNotFoundError(id);
    if (existing.expiresAt <= now) throw new Error(`Directive "${id}" expired at ${new Date(existing.expiresAt).toISOString()} - issue a new one.`);

    let updated = existing;
    this.mutate((document) => {
      const record = document.directives[id];
      // A concurrent trim can drop the directive between our read and this attempt's document.
      if (!record) throw new DirectiveNotFoundError(id);
      record.ack = { at: now, by, ...(note === undefined ? {} : { note }) };
      updated = record;
      document.events.push({ at: now, type: "ack", actor: by, detail: id, ...(note === undefined ? {} : { rationale: note }) });
      this.trimEvents(document);
      return true;
    }, now);
    return updated;
  }

  public resolveDirective(id: string, by: string, now = Date.now()): DirectiveRecord {
    assertSafeKey("directive id", id);
    const existing = this.read().directives[id];
    if (!existing) throw new DirectiveNotFoundError(id);
    let updated = existing;
    this.mutate((document) => {
      const record = document.directives[id];
      // A concurrent trim can drop the directive between our read and this attempt's document.
      if (!record) throw new DirectiveNotFoundError(id);
      record.resolvedAt = now;
      updated = record;
      document.events.push({ at: now, type: "resolve", actor: by, detail: id });
      this.trimEvents(document);
      return true;
    }, now);
    return updated;
  }

  /**
   * Directives that need attention: never acknowledged, and either expired or older than the grace period.
   * This is what stops a directive from stalling silently - the issuer (or a human) sees it here.
   */
  public escalations(now = Date.now(), graceMs = 120_000): DirectiveRecord[] {
    return Object.values(this.read().directives)
      .filter((record) => record.ack === undefined && record.resolvedAt === undefined)
      .filter((record) => record.expiresAt <= now || now - record.createdAt > graceMs)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  private trimDirectives(document: PresenceDocument, now: number): void {
    const entries = Object.entries(document.directives);
    if (entries.length <= 200) return;
    const disposable = entries
      .filter(([, record]) => record.resolvedAt !== undefined || record.expiresAt <= now)
      .sort((left, right) => left[1].createdAt - right[1].createdAt);
    for (const [id] of disposable) {
      if (Object.keys(document.directives).length <= 200) break;
      delete document.directives[id];
    }
  }

  /**
   * Compaction-immune conditional instructions (Paper §VIII): resolves directory `GOTCHAS.md` /
   * `FOOTGUNS.md` files, board-registered `rule:*` / `gotcha:*` signals, and path-sensitivity
   * footgun guards for the exact paths an agent is claiming or checkpointing.
   */
  public resolveConditionalInstructions(paths: string[] = [], now = Date.now()): ConditionalInstruction[] {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    const results: ConditionalInstruction[] = [];
    const seen = new Set<string>();
    const add = (item: ConditionalInstruction): void => {
      const key = `${item.source}::${item.match}::${item.instruction}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(item);
      }
    };

    const activeSignals = this.signals({}, now);

    for (const rawPath of paths) {
      if (typeof rawPath !== "string" || !rawPath.trim()) continue;
      const normalized = rawPath.replace(/\\/g, "/").trim();
      const sensitivity: "open" | "standard" | "restricted" =
        /(?:^|[/.\s])\.\.(?:$|[/.\s])/.test(normalized) ||
        /(?:^|[/.\s_-])(?:\.env|secrets?|credentials?|auth|oauth|jwt|tokens?|crypto|keys?|billing|payments?|server|control-plane|deploy|helm|docker|terraform|k8s|prod)(?:$|[/.\s_-])/i.test(
          normalized,
        )
          ? "restricted"
          : /(?:^|\/)(?:docs?|examples?|README|CHANGELOG|LICENSE|CONTRIBUTING)[^/]*$|\.(?:md|txt|rst)$/i.test(normalized)
            ? "open"
            : "standard";
      // 1. Built-in conditional footgun rules attached to path patterns
      if (normalized === "src/index.ts" || normalized === "src/corpus.ts") {
        add({
          match: normalized,
          sensitivity,
          source: "builtin",
          instruction:
            "Pinned API surface: tests/api-surface.test.ts snapshots all 66 exports of src/index.ts + src/corpus.ts. Do not add or remove runtime exports without updating the contract.",
        });
      }
      if (normalized.includes("offline-policy.ts") || normalized.includes("bench/corpus.json")) {
        add({
          match: normalized,
          sensitivity,
          source: "builtin",
          instruction:
            "Deterministic floor contract: run `bun run bench` (77/77 exact) and keep all regexes ReDoS-safe.",
        });
      }
      if (normalized.startsWith("server/") || normalized.includes("control-plane")) {
        add({
          match: normalized,
          sensitivity: "restricted",
          source: "builtin",
          instruction:
            "Restricted control-plane surface: enforce readBoundedJson (64KB cap), constant-time SHA-256 token digests, and scrubSecrets() before any disk write.",
        });
      }
      if (/\.(?:tsx|jsx|css)$/i.test(normalized)) {
        add({
          match: "*.tsx/*.css",
          sensitivity,
          source: "builtin",
          instruction:
            "UI style circuit: enforce design-token consistency and boundary spacing before component implementation.",
        });
      }

      // 2. Board-registered conditional rules (`rule:<pattern>` or `gotcha:<pattern>`)
      for (const sig of activeSignals) {
        if (sig.key.startsWith("rule:") || sig.key.startsWith("gotcha:")) {
          const pattern = sig.key.slice(sig.key.indexOf(":") + 1).trim();
          const matches =
            pattern === "*" ||
            normalized.includes(pattern) ||
            (pattern.startsWith("*.") && normalized.endsWith(pattern.slice(1)));
          if (matches && sig.value !== undefined) {
            add({
              match: pattern,
              sensitivity,
              source: "signal",
              instruction: typeof sig.value === "string" ? sig.value.slice(0, 1000) : JSON.stringify(sig.value).slice(0, 1000),
            });
          }
        }
      }

      const dir = path.dirname(normalized);
      if (dir && dir !== "." && !normalized.includes("..")) {
        const rootDir = path.resolve(process.cwd());
        for (const filename of ["GOTCHAS.md", "FOOTGUNS.md"]) {
          const candidateFile = path.resolve(rootDir, dir, filename);
          if (candidateFile.startsWith(rootDir) && fs.existsSync(candidateFile)) {
            try {
              const text = fs.readFileSync(candidateFile, "utf8").trim().slice(0, 2000);
              if (text.length > 0) {
                add({
                  match: `${dir}/${filename}`,
                  sensitivity,
                  source: "file",
                  instruction: text,
                });
              }
            } catch {
              // Ignore unreadable gotcha file.
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * One call before an irreversible step: what changed since this agent last looked, what it is owed
   * (directives), what it would collide with, and what is hot. Advances the agent's `seenAt`, so the
   * next checkpoint returns only what is new.
   */
  public checkpoint(agentId: string, options: { paths?: string[]; now?: number; mode?: ClaimRecord["mode"] } = {}) {
    assertSafeKey("agent id", agentId);
    const now = options.now ?? Date.now();
    const document = this.read();
    const previous = document.agents[agentId]?.seenAt;
    const changed = document.events.filter((event) => (previous === undefined ? true : event.at > previous)).slice(-50).reverse();
    const live = Object.values(document.claims).filter((record) => record.expiresAt > now);
    const scoped = options.paths === undefined ? live : live.filter((record) => options.paths!.includes(record.path));
    const hot = Object.entries(document.alarms)
      .map(([key, record]) => ({
        key,
        strength: Number((record.count * Math.exp(-Math.max(0, now - record.lastAt) / this.decayTauMs)).toFixed(2)),
        ...(record.note === undefined ? {} : { note: record.note }),
      }))
      .filter((entry) => entry.strength > 0.05)
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 10);
    const directives = Object.values(document.directives)
      .filter((record) => record.agentId === agentId && record.resolvedAt === undefined && record.expiresAt > now)
      .sort((left, right) => left.createdAt - right.createdAt);
    const escalations = this.escalations(now);

    this.mutate((document) => {
      const agent = document.agents[agentId];
      if (agent) {
        agent.seenAt = now;
        agent.heartbeatAt = now;
      } else {
        document.agents[agentId] = { id: agentId, kind: "agent", pid: process.pid, startedAt: now, heartbeatAt: now, seenAt: now };
      }
      return true;
    }, now);

    const mode = options.mode ?? "edit";
    const others = scoped.filter((record) => record.agentId !== agentId);
    const conflicts = others.filter((record) => CLAIM_CONTENTION[mode][record.mode]);
    const observers = others.filter((record) => !CLAIM_CONTENTION[mode][record.mode]);

    return {
      since: previous,
      now,
      changed,
      claims: scoped.map(shapeClaim),
      conflicts: conflicts.map(shapeConflict),
      summary: claimSummary(conflicts, observers),
      hot,
      directives,
      signals: this.signals({}, now),
      escalations,
      conditionalInstructions: this.resolveConditionalInstructions(options.paths ?? [], now),
    };
  }

  // ---- read model for the MCP boundary ----

  /** Everything a starting agent needs: who is alive, who holds what and why, what is hot, what just happened. */
  public presence(options: { agentId?: string; paths?: string[]; eventLimit?: number; mode?: ClaimRecord["mode"] } = {}, now = Date.now()): Record<string, unknown> {
    const document = this.read();
    const alive = Object.values(document.agents)
      .filter((agent) => now - agent.heartbeatAt <= this.agentTtlMs)
      .sort((left, right) => right.heartbeatAt - left.heartbeatAt);
    const live = Object.values(document.claims).filter((record) => record.expiresAt > now);
    const scoped = options.paths === undefined ? live : live.filter((record) => options.paths!.includes(record.path));

    const trails = (field: "alarms" | "attractants") =>
      Object.entries(document[field])
        .map(([key, record]) => ({
          key,
          strength: Number((record.count * Math.exp(-Math.max(0, now - record.lastAt) / this.decayTauMs)).toFixed(2)),
          ...(record.note === undefined ? {} : { note: record.note }),
          lastAt: record.lastAt,
        }))
        .filter((entry) => entry.strength > 0.05)
        .sort((left, right) => right.strength - left.strength)
        .slice(0, 10);

    const mode = options.mode ?? "edit";
    const self = options.agentId;
    const others = self === undefined ? [] : scoped.filter((record) => record.agentId !== self);
    const conflicts = others.filter((record) => CLAIM_CONTENTION[mode][record.mode]);
    const observers = others.filter((record) => !CLAIM_CONTENTION[mode][record.mode]);

    return {
      board: this.filePath,
      agents: alive.map((agent) => ({ id: agent.id, kind: agent.kind, pid: agent.pid, since: agent.startedAt, lastSeen: agent.heartbeatAt })),
      claims: scoped.map(shapeClaim),
      conflicts: conflicts.map(shapeConflict),
      summary: self === undefined ? "no agent id: every claim above is informational" : claimSummary(conflicts, observers),
      hot: trails("alarms"),
      attracting: trails("attractants"),
      signals: this.signals({}, now),
      directives:
        options.agentId === undefined
          ? []
          : this.directives(options.agentId, now).map((record) => ({
              id: record.id,
              kind: record.kind,
              target: record.target,
              issuedBy: record.issuedBy,
              ...(record.rationale === undefined ? {} : { why: record.rationale }),
              expiresAt: record.expiresAt,
              ...(record.ack === undefined ? {} : { ackedAt: record.ack.at }),
            })),
      escalations: this.escalations(now).map((record) => ({
        id: record.id,
        agentId: record.agentId,
        kind: record.kind,
        target: record.target,
        issuedAt: record.createdAt,
        expired: record.expiresAt <= now,
      })),
      recent: document.events.slice(-(options.eventLimit ?? 10)).reverse(),
      advisory: "Presence is advisory: it never blocks an action. The shield floor remains authoritative.",
    };
  }
}
