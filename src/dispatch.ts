/**
 * Dispatch planning: menu synthesis, the model-facing state payload, and replay diagnostics.
 *
 * Extracted from `coordinator.ts`: these functions are shared by live planning and deterministic replay,
 * and apart from the board they read they are pure - which is what lets the menu policy (Exp 84) be
 * tested without an engine.
 */
import type { Blackboard } from "./blackboard.js";
import type { DecisionLogEntry } from "./coordinator.js";
import type { BlackboardSnapshot, DataSensitivity, Job, Worker } from "./types.js";

export interface DispatchPlan {
  snapshot: BlackboardSnapshot;
  idleWorkers: Worker[];
  candidates: Job[];
  isRecovery: boolean;
  menu: Record<string, string>;
  keyMap: Map<string, { jobId: string; workerId: string }>;
}

export const MAX_STATE_TEXT = 400;

/**
 * Caps the dispatch menu (candidates × idle workers) at 400 structured entries. Truncation is
 * deterministic - the first pairs in board order - so planning and replay always see the same menu,
 * and pairs beyond the cap stay on the board for a later wave: a big-but-legal board must never
 * inflate the model payload toward the 512KB transport guard.
 */
export const MAX_MENU_ENTRIES = 400;

/** Caps model-bound text so a runaway log line cannot inflate the coordination payload. */
export function clampText(value: string | undefined, max = MAX_STATE_TEXT): string | undefined {
  if (value === undefined) return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function rankOfTier(tier: DataSensitivity | undefined): number {
  if (tier === undefined || tier === "restricted") return 2;
  if (tier === "standard") return 1;
  if (tier === "open") return 0;
  return -1;
}
/**
 * Infers file/task data sensitivity per the Security-Aware Routing table:
 * - `restricted`: secrets, env, auth, tokens, billing, server/control-plane, or deployment infra
 * - `open`: public docs, markdown, examples, changelogs, licenses
 * - `standard`: application source and test code
 */
export function inferTargetSensitivity(target?: string, title?: string): DataSensitivity {
  const probe = `${target ?? ""} ${title ?? ""}`.trim();
  if (
    /(?:^|[/\\.\s])\.\.(?:$|[/\\.\s])/.test(probe) ||
    /(?:^|[/\\.\s_-])(?:\.env|secrets?|credentials?|auth|oauth|jwt|tokens?|crypto|keys?|billing|payments?|server|control-plane|deploy|helm|docker|terraform|k8s|prod)(?:$|[/\\.\s_-])/i.test(
      probe,
    )
  ) {
    return "restricted";
  }
  if (
    target !== undefined &&
    (/(?:^|[/\\])(?:docs?|examples?|README|CHANGELOG|LICENSE|CONTRIBUTING)[^/\\]*$/i.test(target) ||
      /\.(?:md|txt|rst)$/i.test(target))
  ) {
    return "open";
  }
  return "standard";
}

/**
 * Synthesizes the dispatch menu (and its key map) from the board - shared by planning and replay.
 * Wounded work takes precedence over pending work, and either way every candidate is paired with every
 * idle worker under a structured key that survives underscores and special characters in ids.
 *
 * Returns null when nothing is *dispatchable*. Running jobs may still be in flight, so null is not a
 * completion signal - the supervisor's completion gate checks running work separately.
 */
export function buildDispatchPlan(board: Blackboard): DispatchPlan | null {
  const snapshot = board.getSnapshot();
  const idleWorkers = snapshot.workers.filter((w) => w.status === "idle");
  const actionableJobs = snapshot.jobs.filter((j) => j.status === "wounded" || j.status === "pending");
  if (actionableJobs.length === 0) {
    return null;
  }

  const wounded = actionableJobs.filter((j) => j.status === "wounded");
  const candidates = wounded.length > 0 ? wounded : actionableJobs;
  const isRecovery = wounded.length > 0;

  const menu: Record<string, string> = {};
  const keyMap = new Map<string, { jobId: string; workerId: string }>();

  const eligibleWorkersSet = new Set<string>();
  for (const job of candidates) {
    const required = job.sensitivity ?? inferTargetSensitivity(job.target, job.title);
    const requiredRank = rankOfTier(required);
    for (const worker of idleWorkers) {
      if (keyMap.size >= MAX_MENU_ENTRIES) break;
      const workerRank = rankOfTier(worker.trustTier);
      if (workerRank < requiredRank) continue;
      eligibleWorkersSet.add(worker.id);
      // Structured key with a unique index to prevent collision even with underscores
      const key = `assign::${job.id}::${worker.id}`;
      keyMap.set(key, { jobId: job.id, workerId: worker.id });

      menu[key] = isRecovery
        ? `Recover wounded task ${job.id} by re-dispatching to healthy idle worker ${worker.name}`
        : `Assign task ${job.id} (${clampText(job.title) ?? ""}) to idle worker ${worker.name}`;
    }
    if (keyMap.size >= MAX_MENU_ENTRIES) break;
  }

  const filteredIdleWorkers =
    keyMap.size === 0 && idleWorkers.some((w) => w.trustTier !== undefined)
      ? []
      : idleWorkers.filter((w) => eligibleWorkersSet.size === 0 || eligibleWorkersSet.has(w.id));

  return { snapshot, idleWorkers: filteredIdleWorkers, candidates, isRecovery, menu, keyMap };
}

/**
 * Menu hints from calibration profiles - the profile clamp extended to menus. A hint key names a
 * menu entity as `<kind>:<id>` with `kind` from this static vocabulary; its value steers that
 * entity's entries (`prefer` floats them to the front, `avoid` filters them out). Hints are data,
 * never code: an unknown key, an out-of-vocabulary target, or an oversized payload makes the whole
 * set hostile and it is rejected as a unit (see {@link validateMenuHints}).
 */
export const MENU_HINT_TARGET_KINDS: Record<"job" | "worker", true> = { job: true, worker: true };

/** Bounds on a stored hint set, in the `PROFILE_BOUNDS` spirit: data has size limits. */
export const MAX_MENU_HINTS = 32;
export const MAX_MENU_HINT_KEY = 128;

/**
 * Validates a stored hint set at the profile gateway. Any violation rejects the WHOLE set (with the
 * reason in `rejected`) - partial sanitising would let a hostile set smuggle effective hints past
 * review.
 */
export function validateMenuHints(raw: unknown): { hints: Record<string, "prefer" | "avoid">; rejected?: string } {
  if (raw === null || typeof raw !== "object") {
    return { hints: {}, rejected: "unknown hint keys: hint set is not an object" };
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_MENU_HINTS) {
    return { hints: {}, rejected: `oversized payloads: ${entries.length} hints (max ${MAX_MENU_HINTS})` };
  }
  const hints: Record<string, "prefer" | "avoid"> = {};
  for (const [key, value] of entries) {
    if (key.length > MAX_MENU_HINT_KEY) {
      return { hints: {}, rejected: `oversized payloads: hint key of ${key.length} chars (max ${MAX_MENU_HINT_KEY})` };
    }
    const separator = key.indexOf(":");
    if (separator <= 0) {
      return { hints: {}, rejected: `unknown hint keys: "${key}"` };
    }
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (MENU_HINT_TARGET_KINDS[kind as "job" | "worker"] !== true || id === "") {
      return { hints: {}, rejected: `out-of-vocabulary targets: "${key}"` };
    }
    if (value !== "prefer" && value !== "avoid") {
      return { hints: {}, rejected: `invalid hint values: "${key}"` };
    }
    hints[key] = value;
  }
  return { hints };
}

/**
 * Applies validated hints to an already-built menu: `prefer` floats matching entries to the front
 * (stable), `avoid` filters them out - clamped so the menu is never emptied below its floor entry,
 * the stable first pair (exactly the deterministic offline fallback). Pure over the plan: only the
 * offered menu changes, so hints can never add an option, widen the candidates, or touch the floor.
 */
export function applyMenuHints(
  menu: Record<string, string>,
  keyMap: Map<string, { jobId: string; workerId: string }>,
  hints: Record<string, "prefer" | "avoid">
): Record<string, string> {
  const entries = Object.entries(menu);
  if (entries.length === 0 || Object.keys(hints).length === 0) return menu;

  const kept: Array<[string, string]> = [];
  for (const entry of entries) {
    const mapping = keyMap.get(entry[0]);
    const avoided =
      mapping !== undefined &&
      (hints[`job:${mapping.jobId}`] === "avoid" || hints[`worker:${mapping.workerId}`] === "avoid");
    if (!avoided) kept.push(entry);
  }
  // Floor clamp: filtering may shrink the menu but never past the stable first pair.
  if (kept.length === 0) kept.push(entries[0]);

  const preferred: Array<[string, string]> = [];
  const rest: Array<[string, string]> = [];
  for (const entry of kept) {
    const mapping = keyMap.get(entry[0]);
    const wanted =
      mapping !== undefined &&
      (hints[`job:${mapping.jobId}`] === "prefer" || hints[`worker:${mapping.workerId}`] === "prefer");
    (wanted ? preferred : rest).push(entry);
  }
  return Object.fromEntries(preferred.concat(rest));
}

/** The bounded state a dispatch decision is made over. `alarmLevel` is injected so this stays pure. */
export function buildDispatchState(
  plan: DispatchPlan,
  alarmLevel: (target: string) => number
): {
  activeWave: number;
  unresolvedJobs: Array<{
    id: string;
    title?: string;
    status: string;
    sensitivity: DataSensitivity;
    attempts: number;
    lastError?: string;
    alarmLevel: number;
  }>;
  idleWorkers: Array<{ id: string; name: string; trustTier?: DataSensitivity }>;
  recentEvents: Array<string | undefined>;
} {
  return {
    activeWave: plan.snapshot.activeWave,
    unresolvedJobs: plan.candidates.slice(0, MAX_MENU_ENTRIES).map((job) => ({
      id: job.id,
      title: clampText(job.title),
      status: job.status,
      sensitivity: job.sensitivity ?? inferTargetSensitivity(job.target, job.title),
      attempts: job.attempts,
      lastError: clampText(job.error),
      alarmLevel: alarmLevel(job.target || job.id),
    })),
    idleWorkers: plan.idleWorkers.slice(0, MAX_MENU_ENTRIES).map((worker) => ({
      id: worker.id,
      name: worker.name,
      ...(worker.trustTier !== undefined ? { trustTier: worker.trustTier } : {}),
    })),
    recentEvents: plan.snapshot.events.slice(-5).map((event) => clampText(`${event.type}: ${event.detail}`, 200)),
  };
}

/** The instruction that travels with the menu. Wording lives here so planning and prompts stay in step. */
export function dispatchInstructions(isRecovery: boolean): string {
  return isRecovery
    ? "Select the optimal re-dispatch assignment to recover the wounded task with an idle worker."
    : "Select the optimal task assignment matching pending work to available idle workers.";
}

/** Explains why a recorded decision cannot be rebuilt against the current replay board. */
export function explainMenuMiss(plan: DispatchPlan, entry: DecisionLogEntry, snapshot: BlackboardSnapshot): string {
  if (!entry.jobId || !entry.workerId) {
    return `recorded action "${entry.action}" carries no job/worker ids`;
  }
  const job = snapshot.jobs.find((candidate) => candidate.id === entry.jobId);
  if (!job) return `recorded job ${entry.jobId} is not on the replay board`;
  const worker = snapshot.workers.find((candidate) => candidate.id === entry.workerId);
  if (!worker) return `recorded worker ${entry.workerId} is not on the replay board`;
  if (job.status !== "pending" && job.status !== "wounded") {
    return `recorded job ${entry.jobId} is "${job.status}", not dispatchable`;
  }
  if (worker.status !== "idle") {
    return `recorded worker ${entry.workerId} is "${worker.status}", not idle`;
  }
  const candidateIds = plan.candidates.map((candidate) => candidate.id).join(", ");
  return `recorded action is not on the replay menu (candidates: ${candidateIds || "none"})`;
}
