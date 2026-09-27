/**
 * Durable state storage behind `PresenceBoard` — the seam that lifts the board's single-process ceiling.
 *
 * The board document is shared by whole swarms of OS processes, so read-modify-write must be one writer
 * at a time. Two variants live behind this interface, selected by `SWARM_SENTINEL_STATE_STORE`
 * (`file` | `sqlite`, default `file`):
 *
 * - **FileStateStore** — one JSON document plus a lock file created with exclusive-create. The lock
 *   carries the time it was taken: a writer that crashes cannot wedge the board, because once the lock
 *   is older than `lockTtlMs` the next writer takes it over. Waiting writers back off with a bounded
 *   exponential delay and a bounded budget — a live holder is reported (`StateStoreBusyError`), never
 *   spun on forever.
 * - **SqliteStateStore** — the same document as one row, mutated inside a `BEGIN IMMEDIATE` transaction.
 *   SQLite serialises writers natively and rolls a crashed writer's half-written transaction back on
 *   the next open: crash recovery is the engine's job, not a human's.
 *
 * Both variants honour the same contract, so every wave-2 board semantic (the claim contention matrix,
 * ENOENT-only read fallback, quarantine-on-corrupt, prune-on-mutate, `mutate()` return threading,
 * prototype-immune maps) is preserved unchanged above this line.
 *
 * SQLite drivers: `node:sqlite` (Node >= 22) where it exists, `bun:sqlite` otherwise — Bun (as of 1.3)
 * does not implement `node:sqlite`, and both are built-ins of their runtime. Zero npm dependencies
 * either way, and the `file` variant never touches SQLite at all.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

export type StateStoreKind = "file" | "sqlite";

/** What an `update()` change hands back: the state to persist and the caller's outcome to thread out. */
export interface StateUpdate<R> {
  /** The document to persist — written only by the attempt whose write actually lands. */
  next: unknown;
  /** The caller's outcome; a discarded attempt's result never escapes (allocate/release count on this). */
  result: R;
}

export interface StateStore {
  readonly kind: StateStoreKind;
  /**
   * The parsed persisted state, or `undefined` when the store is absent or was quarantined. Only an
   * absent store reads empty: any other read failure (EPERM, EISDIR, a file that is not a database ...)
   * surfaces, because swallowing it would hand callers an empty document and the next write would wipe
   * real state. Unparseable persisted content is quarantined aside — never a caller failure.
   */
  load(): unknown;
  /**
   * Serialised read-modify-write. `change` sees the current state and returns `false` for "nothing to
   * write" or a `StateUpdate` to persist; the result comes from the attempt whose write landed.
   */
  update<R>(change: (current: unknown) => StateUpdate<R> | false): R | false;
}

/** Raised when a live holder keeps the file lock past the whole wait budget — a wedged board is never silent. */
export class StateStoreBusyError extends Error {
  constructor(
    public readonly boardPath: string,
    public readonly lockTtlMs: number
  ) {
    super(`Board store "${boardPath}" stayed locked past the wait budget — a holder older than ${lockTtlMs}ms would have been taken over.`);
    this.name = "StateStoreBusyError";
  }
}

/** Raised for a `SWARM_SENTINEL_STATE_STORE` value that names no store: loud beats silently wrong. */
export class StateStoreConfigError extends Error {
  constructor(public readonly value: string) {
    super(`SWARM_SENTINEL_STATE_STORE="${value}" names no state store — use "file" or "sqlite".`);
    this.name = "StateStoreConfigError";
  }
}

export interface FileStateStoreOptions {
  /** Age at which a lock is presumed to belong to a crashed writer and may be taken over. */
  lockTtlMs?: number;
  /** How long `update()` waits for a live holder before giving up with `StateStoreBusyError`. */
  waitBudgetMs?: number;
}

/** Crash-lock horizon: far longer than any critical section (milliseconds), short enough to self-heal. */
const DEFAULT_LOCK_TTL_MS = 2_000;

/** Slack on top of the TTL, so a crashed holder's lock always expires inside one wait budget. */
const LOCK_SLACK_MS = 4_000;

/** Attempts per update: a lost write race replays against the newer state, then the error surfaces. */
const MAX_UPDATE_ATTEMPTS = 5;

/** Synchronous backoff (Node has no sync sleep): used only while waiting out another writer. */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

/** Parses a document slot; anything unparseable or absent reads as `undefined` (absent). */
function parseSlot(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * File-backed JSON with cross-process one-writer locking.
 *
 * Locking is a sibling `<board>.lock` file created with `wx` (exclusive create — the OS arbitrates, no
 * library needed). The lock body records when it was taken; a lock older than `lockTtlMs` belongs to a
 * writer that died inside its critical section and is taken over. The take-over re-reads the lock and
 * only unlinks the exact file it measured, so it cannot remove a fresh lock written after the look.
 */
export class FileStateStore implements StateStore {
  public readonly kind = "file";
  private readonly lockPath: string;
  private readonly lockTtlMs: number;
  private readonly waitBudgetMs: number;

  constructor(private readonly filePath: string, options: FileStateStoreOptions = {}) {
    this.lockPath = `${filePath}.lock`;
    this.lockTtlMs = options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.waitBudgetMs = options.waitBudgetMs ?? this.lockTtlMs + LOCK_SLACK_MS;
  }

  public load(): unknown {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch (error) {
      // Only a *missing* board is an empty board. Any other read error must surface (see StateStore).
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      // Unparseable state is quarantined aside (same name the board has always used) and reads absent.
      try {
        fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Best effort: an unquarantinable file is simply not read as state.
      }
      return undefined;
    }
  }

  public update<R>(change: (current: unknown) => StateUpdate<R> | false): R | false {
    for (let attempt = 1; ; attempt++) {
      const release = this.acquire();
      try {
        const outcome = change(this.load());
        if (outcome === false) return false;
        try {
          this.persist(outcome.next);
        } catch (error) {
          // A lost write race (the test suite drives this deterministically) is replayed against the
          // newer state; only the attempt whose write landed reports its result.
          if (attempt >= MAX_UPDATE_ATTEMPTS) throw error;
          continue;
        }
        return outcome.result;
      } finally {
        release();
      }
    }
  }

  private persist(state: unknown): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
    // Windows raises EPERM/EACCES when the rename target is momentarily held (a concurrent writer, an
    // indexer, antivirus). Without this retry a busy board kills its writers. The payload is already on
    // disk, so a short bounded retry is cheap.
    let lastError: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        fs.renameSync(temporary, this.filePath);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") break;
        sleepSync(5 + attempt * 15);
      }
    }
    try { fs.unlinkSync(temporary); } catch { /* the temp file is worthless either way */ }
    throw lastError;
  }

  /** Acquires the write lock; the returned function releases exactly the lock this call took. */
  private acquire(): () => void {
    const token = `${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    const deadline = Date.now() + this.waitBudgetMs;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, `${JSON.stringify({ token, at: Date.now() })}\n`, { flag: "wx" });
        return () => {
          try { fs.unlinkSync(this.lockPath); } catch { /* taken over past its TTL, or already released */ }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // A lock left by a crashed writer is taken over; contention (or a transient EPERM/EBUSY) is
        // waited out with bounded backoff (2ms doubling to a 25ms ceiling) inside a bounded budget.
        if (code === "EEXIST" && this.takeOverExpiredLock()) continue;
        if (Date.now() >= deadline) {
          if (code === "EEXIST") throw new StateStoreBusyError(this.filePath, this.lockTtlMs);
          throw error;
        }
        sleepSync(Math.min(2 * 2 ** Math.min(attempt, 4), 25));
      }
    }
  }

  /** Steals a lock whose holder crashed: past the TTL and still the exact file we measured. */
  private takeOverExpiredLock(): boolean {
    let raw: string;
    let takenAt: number;
    try {
      raw = fs.readFileSync(this.lockPath, "utf-8");
      takenAt = fs.statSync(this.lockPath).mtimeMs;
    } catch {
      return false; // gone this instant: the regular retry paths settle who writes next
    }
    try {
      const parsed = JSON.parse(raw) as { at?: unknown };
      if (typeof parsed.at === "number") takenAt = parsed.at;
    } catch {
      // A holder that crashed between creating and filling its lock: the file mtime still ages it out.
    }
    if (Date.now() - takenAt <= this.lockTtlMs) return false;
    try {
      if (fs.readFileSync(this.lockPath, "utf-8") !== raw) return false; // replaced since we measured it
      fs.unlinkSync(this.lockPath);
    } catch {
      return false;
    }
    return true;
  }
}

/** The smallest driver surface both built-in SQLite modules are adapted to. */
interface SqliteDriver {
  exec(sql: string): void;
  get(sql: string, params: unknown[]): Record<string, unknown> | undefined;
  run(sql: string, params: unknown[]): void;
  close(): void;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
  close(): void;
}

interface BunSqliteDatabase {
  exec(sql: string): void;
  query(sql: string): { get(...params: unknown[]): unknown };
  run(sql: string, ...params: unknown[]): unknown;
  close(): void;
}

/** SQLITE_BUSY / SQLITE_LOCKED from either driver — contention to replay, unlike a change's own error. */
function isSqliteBusy(error: unknown): boolean {
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    candidate.errcode === 5 ||
    candidate.errcode === 6 ||
    /busy|locked/i.test(String(candidate.code ?? "")) ||
    /busy|locked/i.test(String(candidate.message ?? ""))
  );
}

/** Opens one transaction-capable connection: schema ready, writers wait up to 5s before surfacing BUSY. */
function openSqlite(dbPath: string): SqliteDriver {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const load = createRequire(import.meta.url);
  let nodeSqlite: { DatabaseSync: new (file: string) => NodeSqliteDatabase } | undefined;
  try {
    // Unchecked cast at the module boundary: the shape is pinned by NodeSqliteDatabase above.
    nodeSqlite = load("node:sqlite") as { DatabaseSync: new (file: string) => NodeSqliteDatabase };
  } catch {
    // Bun has not implemented node:sqlite; bun:sqlite is the same engine behind another built-in name.
  }
  let driver: SqliteDriver;
  if (nodeSqlite === undefined) {
    const database = new (load("bun:sqlite") as { Database: new (file: string) => BunSqliteDatabase }).Database(dbPath);
    driver = {
      exec: (sql) => database.exec(sql),
      get: (sql, params) => (database.query(sql).get(...params) ?? undefined) as Record<string, unknown> | undefined,
      run: (sql, params) => { database.run(sql, ...params); },
      close: () => database.close(),
    };
  } else {
    const database = new nodeSqlite.DatabaseSync(dbPath);
    driver = {
      exec: (sql) => database.exec(sql),
      get: (sql, params) => database.prepare(sql).get(...params) as Record<string, unknown> | undefined,
      run: (sql, params) => { database.prepare(sql).run(...params); },
      close: () => database.close(),
    };
  }
  // A file that is not a database fails here — close the fresh handle before surfacing, or the file
  // stays locked and the caller cannot even clean up around it.
  try {
    driver.exec("PRAGMA busy_timeout = 5000");
    driver.exec("CREATE TABLE IF NOT EXISTS board_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, updatedAt INTEGER NOT NULL)");
  } catch (error) {
    driver.close();
    throw error;
  }
  return driver;
}

/**
 * SQLite-backed state behind the same seam: the whole document is one row, and every mutation is a
 * `BEGIN IMMEDIATE` transaction — one writer at a time without a lock file, and a writer that dies
 * mid-transaction is rolled back by the engine on the next open. Connections are opened per operation,
 * so a long-lived board never pins the file (Windows cleanup and log rotation thank us).
 */
export class SqliteStateStore implements StateStore {
  public readonly kind = "sqlite";
  /** Where the row lives: `board.json` becomes `board.sqlite`; the board path itself stays logical. */
  public readonly dbPath: string;

  constructor(boardPath: string) {
    this.dbPath = boardPath.endsWith(".json") ? `${boardPath.slice(0, -".json".length)}.sqlite` : `${boardPath}.sqlite`;
  }

  public load(): unknown {
    if (!fs.existsSync(this.dbPath)) return undefined;
    const db = openSqlite(this.dbPath);
    try {
      return this.readBody(db);
    } finally {
      db.close();
    }
  }

  public update<R>(change: (current: unknown) => StateUpdate<R> | false): R | false {
    const db = openSqlite(this.dbPath);
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          db.exec("BEGIN IMMEDIATE");
          const outcome = change(this.readBody(db));
          if (outcome === false) {
            db.exec("ROLLBACK");
            return false;
          }
          db.run(
            "INSERT INTO board_state(id, body, updatedAt) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updatedAt = excluded.updatedAt",
            [`${JSON.stringify(outcome.next, null, 2)}\n`, Date.now()]
          );
          db.exec("COMMIT");
          return outcome.result;
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
          if (!isSqliteBusy(error)) throw error; // a change's typed error surfaces as-is, never retried away
          if (attempt >= MAX_UPDATE_ATTEMPTS) throw error;
          sleepSync(Math.min(2 * 2 ** Math.min(attempt, 4), 25));
        }
      }
    } finally {
      db.close();
    }
  }

  private readBody(db: SqliteDriver): unknown {
    const row = db.get("SELECT body FROM board_state WHERE id = 1", []);
    const raw = row === undefined ? undefined : String(row.body ?? "");
    const parsed = parseSlot(raw);
    if (raw !== undefined && parsed === undefined) {
      // Unparseable state is quarantined aside and the row dropped — same contract as the file store.
      try {
        fs.writeFileSync(`${this.dbPath}.corrupt-${Date.now()}`, raw, "utf-8");
      } catch {
        // Best effort.
      }
      db.run("DELETE FROM board_state WHERE id = 1", []);
    }
    return parsed;
  }
}

/** Builds the store `SWARM_SENTINEL_STATE_STORE` selects (`file` | `sqlite`, default `file`). */
export function createStateStore(boardPath: string, kind?: StateStoreKind): StateStore {
  const selected = kind ?? process.env.SWARM_SENTINEL_STATE_STORE ?? "file";
  if (selected === "file") return new FileStateStore(boardPath);
  if (selected === "sqlite") return new SqliteStateStore(boardPath);
  throw new StateStoreConfigError(selected);
}
