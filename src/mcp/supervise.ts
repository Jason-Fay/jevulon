/**
 * `sentinel_supervise` actions, extracted from `server.ts`.
 *
 * The handler is a policy layer over the board and the supervisor: `plan` advances a wave through the
 * calibrated dispatch path, `fail` records a worker death (recovery requeues its work), `complete` runs
 * the completion gate, and `assign` reports the board guard's real outcome rather than assuming success.
 */
import type { Blackboard } from "../blackboard.js";
import type { SwarmSupervisor, SupervisorState } from "../langgraph/supervisor.js";
import type { SuperviseToolArgs } from "./validate.js";

export interface SuperviseSession {
  board: Blackboard;
  supervisor: SwarmSupervisor;
  /** Mutable so `plan` can hand the advanced state back to the server without a second getter. */
  lastState: Partial<SupervisorState>;
}

export async function runSuperviseAction(session: SuperviseSession, args: SuperviseToolArgs): Promise<Record<string, unknown>> {
  const { board, supervisor } = session;

  switch (args.action) {
    case "add_job": {
      if (!args.jobId || !args.title) throw new Error("jobId and title are required for add_job");
      board.addJob({ id: args.jobId, title: args.title, status: "pending" });
      return { ok: true, jobId: args.jobId, status: "pending" };
    }

    case "register_worker": {
      if (!args.workerId) throw new Error("workerId is required for register_worker");
      board.registerWorker(args.workerId, args.workerId);
      return { ok: true, workerId: args.workerId, status: "idle" };
    }

    case "assign": {
      if (!args.jobId || !args.workerId) throw new Error("jobId and workerId are required for assign");
      const assigned = board.assign(args.jobId, args.workerId);
      const snapshot = board.getSnapshot();
      const job = snapshot.jobs.find((candidate) => candidate.id === args.jobId);
      const worker = snapshot.workers.find((candidate) => candidate.id === args.workerId);
      return {
        ok: assigned,
        jobId: args.jobId,
        workerId: args.workerId,
        jobStatus: job?.status ?? "missing",
        workerStatus: worker?.status ?? "missing",
        ...(assigned ? {} : { reason: `board guard rejected the assignment: job "${job?.status ?? "missing"}", worker "${worker?.status ?? "missing"}"` }),
      };
    }

    case "complete": {
      if (!args.jobId) throw new Error("jobId is required for complete");
      const result = await supervisor.verifyAndComplete(args.jobId, args.evidence ?? "Completed");
      return {
        ok: result.verified,
        jobId: args.jobId,
        verified: result.verified,
        confidence: result.confidence,
        jobStatus: result.jobStatus,
        latencyMs: result.latencyMs,
      };
    }

    case "fail": {
      if (!args.workerId) throw new Error("workerId is required for fail");
      await supervisor.handleWorkerFailure(args.workerId, args.error ?? "Unhandled error");
      return { ok: true, workerId: args.workerId, status: "dead" };
    }

    case "plan": {
      session.lastState = await supervisor.supervise(session.lastState);
      return { ok: true, state: session.lastState };
    }

    case "classify_circuit": {
      const task = args.title || args.evidence || args.jobId || "Standard execution task";
      const decision = await supervisor.classifyCircuit(task);
      return {
        ok: true,
        action: "classify_circuit",
        circuit: decision.circuit,
        confidence: decision.confidence,
        latencyMs: decision.latencyMs,
        reason: decision.reason,
      };
    }

    case "halt": {
      const reason = args.error || args.title || "Halted by supervisor tool";
      supervisor.halt(reason);
      return { ok: true, action: "halt", halted: true, reason };
    }

    case "resume": {
      supervisor.resume();
      return { ok: true, action: "resume", halted: false };
    }
  }
}
