import { JevClient } from "./client.js";
import type { OversightEvaluation, OversightVerdict } from "./types.js";
import { validateChoice } from "./errors.js";

export interface OversightOptions {
  client?: JevClient;
}

export class OversightStream {
  private client: JevClient;

  constructor(options: OversightOptions = {}) {
    this.client = options.client || new JevClient();
  }

  /**
   * Evaluates an agent event in real-time (~280ms, $0.00008) to catch runaway loops,
   * deadlocks, and worker pathologies before tokens or money are wasted.
   * Throws InvalidJevAnswerError when the model answers outside the verdict menu — an
   * un-judgeable safety monitor must not silently report "continue".
   */
  public async evaluateEvent(event: {
    workerId: string;
    action: string;
    outputOrError: string;
    recentTrace?: string[];
  }): Promise<OversightEvaluation> {
    const instructions =
      "Analyze the agent's recent event. Decide whether execution is healthy, or requires immediate intervention (quarantine worker, reroute job, or halt).";

    const criteria: Record<OversightVerdict, string> = {
      continue: "Normal progress, productive tool execution, or standard retryable errors.",
      quarantine_worker: "Worker is repeating the same failing action, stuck in a circular loop, or unresponsive.",
      reroute_job: "The task has structural obstacles that this specific worker cannot resolve; reassign to another worker.",
      halt_run: "Catastrophic anomaly, runaway token burn, destructive action detected, or systemic deadlock.",
    };

    const state = {
      workerId: event.workerId,
      currentAction: event.action,
      observedResult: event.outputOrError.slice(0, 1000),
      recentEvents: (event.recentTrace || []).slice(-5),
    };

    const res = await this.client.choice(state, instructions, criteria);
    const verdicts = Object.keys(criteria) as OversightVerdict[]; // keys of a Record<OversightVerdict, string>
    const verdict = validateChoice(res.choice, verdicts, "OversightStream.evaluateEvent");

    return {
      verdict,
      confidence: res.confidence,
      reason: `JEV verdict: ${verdict} (${(res.confidence * 100).toFixed(0)}% confidence)`,
      latencyMs: res.latencyMs,
    };
  }
}
