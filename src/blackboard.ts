import { PheromoneField } from "./pheromones.js";
import { EventLog } from "./event-log.js";
import type {
  Job,
  Worker,
  BlackboardEvent,
  BlackboardSnapshot,
  JobStatus,
  WorkerStatus,
  DataSensitivity,
} from "./types.js";
import { inferTargetSensitivity } from "./dispatch.js";

export interface BlackboardOptions {
  maxAttempts?: number; // Anti-thrashing circuit breaker threshold (Exp 75)
  autoHealHook?: (job: Job) => Promise<void> | void; // Mechanical baseline restoration (repo-sentinel)
  maxEvents?: number; // Ring-buffer cap for the event log (default 1000)
}

export class Blackboard {
  private jobs: Map<string, Job> = new Map();
  private workers: Map<string, Worker> = new Map();
  private readonly events: EventLog;
  private activeWave: number = 0;
  private maxAttempts: number;
  private autoHealHook?: (job: Job) => Promise<void> | void;

  // Stigmergic Pheromone Trail Fields (Exp 74)
  private readonly alarms = new PheromoneField(); // α_k: toxic code regions / failing targets
  private readonly attractants = new PheromoneField(); // τ_k: high-yield paths

  constructor(
    initialJobs: Job[] = [],
    initialWorkers: Worker[] = [],
    options: BlackboardOptions = {}
  ) {
    for (const j of initialJobs) this.jobs.set(j.id, { ...j });
    for (const w of initialWorkers) this.workers.set(w.id, { ...w });
    this.maxAttempts = options.maxAttempts ?? 3;
    this.events = new EventLog(options.maxEvents ?? 1000);
    this.autoHealHook = options.autoHealHook;
  }

  public registerWorker(id: string, name: string, options?: { trustTier?: DataSensitivity }): void {
    if (!id || typeof id !== "string" || id.length > 256 || id === "__proto__" || id === "constructor") {
      throw new Error(`Invalid worker ID: "${id}"`);
    }
    this.workers.set(id, {
      id,
      name: typeof name === "string" && name ? name : id,
      status: "idle",
      ...(options?.trustTier !== undefined ? { trustTier: options.trustTier } : {}),
      lastHeartbeat: Date.now(),
    });
  }

  public heartbeat(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.lastHeartbeat = Date.now();
      if (worker.status === "dead") {
        worker.status = "idle";
        worker.currentJobId = undefined;
      }
    }
  }

  public addJob(job: Omit<Job, "attempts">): void {
    if (!job || !job.id || typeof job.id !== "string" || job.id.length > 256) {
      throw new Error(`Invalid job specification or job ID: "${job?.id}"`);
    }
    this.jobs.set(job.id, { ...job, attempts: 0 });
  }

  public logEvent(event: Omit<BlackboardEvent, "timestamp">): void {
    this.events.log(event);
  }

  // ---- Stigmergic Pheromone Methods (Exp 74) ----
  public depositAlarm(target: string, amount = 1.0): void {
    this.alarms.deposit(target, amount);
  }

  public depositAttractant(target: string, amount = 1.0): void {
    this.attractants.deposit(target, amount);
  }

  public getAlarm(target: string): number {
    return this.alarms.get(target);
  }

  public getAttractant(target: string): number {
    return this.attractants.get(target);
  }

  /** Live pheromone-map sizes; both fields are bounded, so a hostile or noisy run cannot grow them without limit. */
  public getPheromoneCounts(): { alarms: number; attractants: number } {
    return { alarms: this.alarms.size, attractants: this.attractants.size };
  }

  public evaporatePheromones(decayRate = 0.1): void {
    this.alarms.evaporate(decayRate);
    this.attractants.evaporate(decayRate);
  }

  /**
   * Worker Death & Anti-Thrashing Circuit Breaker (Exp 75 & Exp 83).
   * Every job still attributed to the dead worker is wounded — not just the last one it was handed —
   * so double-booked or hydrated boards cannot strand work invisibly.
   */
  public async markWorkerDeath(workerId: string, reason = "Process died"): Promise<void> {
    if (!workerId || typeof workerId !== "string") return;
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = "dead";
    worker.currentJobId = undefined;

    const stranded = Array.from(this.jobs.values()).filter(
      (job) => job.workerId === workerId && job.status === "running"
    );
    if (stranded.length === 0) {
      this.logEvent({ type: "worker_death", workerId, detail: `Worker ${workerId} marked dead with no running job (${reason}).` });
      return;
    }
    for (const job of stranded) {
      await this.woundOrEscalate(job, workerId, reason);
    }
  }

  /** Wounds a running job, or escalates it when the anti-thrashing budget is exhausted. */
  private async woundOrEscalate(job: Job, workerId: string | undefined, reason: string): Promise<void> {
    if (job.target) {
      this.depositAlarm(job.target, 1.0); // toxic/flaky path marked
    }

    if (job.attempts >= this.maxAttempts) {
      job.status = "escalated";
      job.error = `Anti-thrashing circuit breaker tripped: task failed ${job.attempts} times (${reason}).`;
      this.logEvent({
        type: "quarantine",
        workerId,
        jobId: job.id,
        detail: `Task ${job.id} escalated: exceeded max retry attempts (${this.maxAttempts}).`,
      });
      return;
    }

    job.status = "wounded";
    job.error = reason;
    this.logEvent({
      type: "worker_death",
      workerId,
      jobId: job.id,
      detail: `Job ${job.id} marked wounded for re-dispatch (attempt #${job.attempts}/${this.maxAttempts}).`,
    });

    if (this.autoHealHook) {
      try {
        await this.autoHealHook(job);
      } catch (err) {
        // Non-blocking auto-heal warning; surfaced on the board rather than swallowed.
        this.logEvent({
          type: "state_change",
          jobId: job.id,
          detail: `Auto-heal hook failed for ${job.target || job.id}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /**
   * Repairs jobs stuck "running" under a worker that is dead or missing (hydrated boards,
   * manual mutation). Returns the number of jobs requeued or escalated.
   */
  public async reconcile(reason = "Orphaned running job reconciled"): Promise<number> {
    const orphans = Array.from(this.jobs.values()).filter((job) => {
      if (job.status !== "running") return false;
      const worker = job.workerId ? this.workers.get(job.workerId) : undefined;
      return !worker || worker.status === "dead" || worker.status === "quarantined";
    });

    for (const job of orphans) {
      await this.woundOrEscalate(job, job.workerId, reason);
    }
    if (orphans.length > 0) {
      this.logEvent({
        type: "state_change",
        detail: `Reconciled ${orphans.length} orphaned running job(s): ${orphans.map((j) => j.id).join(", ")}.`,
      });
    }
    return orphans.length;
  }

  /**
   * Fails a running job (red oracle, oversight reroute): the worker is released and the job is
   * requeued, or escalated when the retry budget is exhausted.
   */
  public async failJob(jobId: string, reason: string): Promise<JobStatus | "missing"> {
    if (!jobId || typeof jobId !== "string") return "missing";
    const job = this.jobs.get(jobId);
    if (!job) return "missing";
    if (job.status !== "running") return job.status;

    const workerId = job.workerId;
    await this.woundOrEscalate(job, workerId, reason);

    if (workerId) {
      const worker = this.workers.get(workerId);
      if (worker && worker.status === "busy" && worker.currentJobId === jobId) {
        worker.status = "idle";
        worker.currentJobId = undefined;
      }
    }
    return job.status;
  }

  /**
   * Quarantines a worker: it is pulled out of the idle pool and its running jobs are requeued.
   * Quarantine survives heartbeats; use {@link releaseWorker} to return it to duty.
   */
  public async quarantineWorker(workerId: string, reason = "Quarantined by oversight"): Promise<boolean> {
    if (!workerId || typeof workerId !== "string") return false;
    const worker = this.workers.get(workerId);
    if (!worker) return false;

    worker.status = "quarantined";
    worker.currentJobId = undefined;

    const stranded = Array.from(this.jobs.values()).filter(
      (job) => job.workerId === workerId && job.status === "running"
    );
    for (const job of stranded) {
      await this.woundOrEscalate(job, workerId, reason);
    }

    this.logEvent({
      type: "quarantine",
      workerId,
      detail: `Worker ${workerId} quarantined: ${reason}${stranded.length > 0 ? ` (${stranded.length} job(s) requeued)` : ""}.`,
    });
    return true;
  }

  /** Returns a quarantined (or dead) worker to the idle pool. */
  public releaseWorker(workerId: string): boolean {
    if (!workerId || typeof workerId !== "string") return false;
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.status = "idle";
    worker.currentJobId = undefined;
    worker.lastHeartbeat = Date.now();
    this.logEvent({ type: "state_change", workerId, detail: `Worker ${workerId} released back to the idle pool.` });
    return true;
  }

  /**
   * Heartbeat watchdog: marks workers whose last heartbeat is older than `staleAfterMs` as dead,
   * which requeues their running jobs. Returns the swept worker ids.
   */
  public async sweepDeadWorkers(staleAfterMs: number, now = Date.now()): Promise<string[]> {
    const stale = Array.from(this.workers.values()).filter(
      (worker) =>
        worker.status !== "dead" &&
        worker.status !== "quarantined" &&
        now - worker.lastHeartbeat > staleAfterMs
    );
    for (const worker of stale) {
      await this.markWorkerDeath(worker.id, `Heartbeat stale for more than ${staleAfterMs}ms`);
    }
    return stale.map((worker) => worker.id);
  }

  /**
   * Dispatches a pending/wounded job to an idle worker.
   * Returns false (and logs a dispatch_rejected event) instead of corrupting the board when the
   * transition is illegal — a completed job, a busy worker, a dead worker.
   */
  public assign(jobId: string, workerId: string): boolean {
    if (!jobId || !workerId || typeof jobId !== "string" || typeof workerId !== "string") return false;
    const job = this.jobs.get(jobId);
    const worker = this.workers.get(workerId);
    if (!job || !worker) return false;

    if (job.status !== "pending" && job.status !== "wounded") {
      this.logEvent({
        type: "dispatch_rejected",
        jobId,
        workerId,
        detail: `Rejected: job ${jobId} is "${job.status}"; only pending or wounded jobs can be dispatched.`,
      });
      return false;
    }

    if (worker.status !== "idle") {
      this.logEvent({
        type: "dispatch_rejected",
        jobId,
        workerId,
        detail: `Rejected: worker ${workerId} is "${worker.status}"; only idle workers can take work.`,
      });
      return false;
    }

    const required = job.sensitivity ?? inferTargetSensitivity(job.target, job.title);
    const requiredRank = required === "restricted" ? 2 : required === "standard" ? 1 : 0;
    const workerRank =
      worker.trustTier === undefined
        ? 2
        : worker.trustTier === "restricted"
          ? 2
          : worker.trustTier === "standard"
            ? 1
            : worker.trustTier === "open"
              ? 0
              : -1;
    if (workerRank < requiredRank) {
      this.logEvent({
        type: "dispatch_rejected",
        jobId,
        workerId,
        detail: `Rejected: worker ${workerId} (trustTier "${String(worker.trustTier)}") is not authorized for "${required}" job ${jobId}.`,
      });
      return false;
    }

    job.status = "running";
    job.workerId = workerId;
    job.attempts++;
    worker.status = "busy";
    worker.currentJobId = jobId;

    this.logEvent({
      type: "state_change",
      jobId,
      workerId,
      detail: `Job ${jobId} assigned to worker ${workerId} (attempt #${job.attempts}/${this.maxAttempts}).`,
    });
    return true;
  }

  /**
   * Completes a running job. Returns false when the job was never dispatched.
   *
   * A gate-verified completion (`verified: true`) is terminal truth: it also heals a wounded/pending
   * job to `done`, so no later plan wave can re-dispatch it. Unverified completion keeps the
   * running-only guard. `verifiedBy` names the issuer of a pre-validated evidence token and is
   * recorded on the completion event for audit — only a verified completion may carry issuer credit.
   */
  public completeJob(jobId: string, evidence: string, options: { verified?: boolean; verifiedBy?: string } = {}): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    const prior = job.status;
    const healed = options.verified === true && (prior === "wounded" || prior === "pending");
    if (prior !== "running" && !healed) {
      this.logEvent({ type: "state_change", jobId, detail: `Rejected completion: job ${jobId} is "${prior}", not running.` });
      return false;
    }

    job.status = "done";
    job.evidence = evidence;

    if (job.target) {
      this.depositAttractant(job.target, 1.0);
    }

    if (job.workerId) {
      const worker = this.workers.get(job.workerId);
      if (worker && worker.status === "busy") {
        worker.status = "idle";
        worker.currentJobId = undefined;
      }
    }

    const credit = options.verified === true && options.verifiedBy !== undefined ? ` verifiedBy: ${options.verifiedBy}` : "";
    this.logEvent({
      type: "state_change",
      jobId,
      detail: `${healed ? `Job ${jobId} healed from ${prior} to done by a verified completion.` : `Job ${jobId} marked complete.`}${credit}`,
    });
    return true;
  }

  /** Number of events currently retained (bounded by `maxEvents`). */
  public getEventCount(): number {
    return this.events.size();
  }

  public getSnapshot(): BlackboardSnapshot {
    return {
      jobs: Array.from(this.jobs.values()).map((j) => ({ ...j })),
      workers: Array.from(this.workers.values()).map((w) => ({ ...w })),
      events: this.events.recent(50),
      activeWave: this.activeWave,
    };
  }

  public nextWave(): number {
    this.evaporatePheromones();
    return ++this.activeWave;
  }
}
