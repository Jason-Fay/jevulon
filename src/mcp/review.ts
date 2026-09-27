/**
 * `sentinel_code_review` - the paid code-review sieve, packaged so an agent can steer its own
 * refactor before it marks a task complete.
 *
 * Order of operations is deliberate: entitlement first (offline Ed25519 license, fail-closed),
 * then the judge program (local override, or served by the control plane to entitled tenants),
 * then the project protocol - N neutral runs over `{source_code, file_path}` and nothing else.
 * The code under review travels only to the caller's own BYOK JEV endpoint: the no-scraping
 * guarantee holds by construction.
 */
import fs from "node:fs";
import path from "node:path";
import { JevClient } from "../client.js";
import { inferTargetSensitivity } from "../dispatch.js";
import { requireLicensedFeature } from "../license.js";
import { aborted, aggregateRuns, questionsFor, summariseRun } from "../sieve.js";
import type { GateResult, SieveProgram } from "../sieve.js";
import type { JevAnswer, Question } from "../types.js";

export interface CodeReviewInput {
  /** Path of the file under review - part of the judge state, and read from disk when no source is given. */
  filePath: string;
  /** The code to audit; when omitted the file is read from `filePath`. */
  sourceCode?: string;
  /** Neutral runs under the project protocol (default 3, clamped to 1–10). */
  runs?: number;
}

/** Structural seam over `JevClient` so the protocol is testable without a live endpoint. */
export interface SieveJudge {
  evaluate(state: unknown, questions: Record<string, Question>): Promise<{ answers: Record<string, JevAnswer> }>;
}

/** Review target read from disk with workspace containment, a restricted-material deny, and a size cap. */
function readReviewSource(filePath: string): string {
  const root = process.cwd();
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`file_path must stay inside the workspace (${root})`);
  }
  if (inferTargetSensitivity(relative) === "restricted") {
    throw new Error(`file_path targets restricted material (${relative}) - pass sourceCode explicitly instead`);
  }
  const stats = fs.statSync(resolved);
  if (!stats.isFile()) throw new Error("file_path must be a regular file");
  if (stats.size > 256 * 1024) throw new Error("file_path exceeds the 256 KB review cap - pass sourceCode with a smaller target");
  return fs.readFileSync(resolved, "utf8");
}

export interface CodeReviewResult {
  file: string;
  program: string;
  runs: number;
  label: string;
  agreement: string;
  confidence: number;
  complexity?: number;
  hazard?: number;
  urgency?: number;
  strategy?: string;
  gates: GateResult[];
  /** True when an abort gate fired - the task must not complete with this code. */
  blocked: boolean;
  /** True when the modal label is clean and no gate fired. */
  clean: boolean;
  verdict: string;
}

async function loadJudgeProgram(): Promise<{ program: SieveProgram; origin: string }> {
  const localPath = process.env.SIEVE_PROGRAM;
  if (localPath) {
    return { program: JSON.parse(fs.readFileSync(localPath, "utf8")) as SieveProgram, origin: localPath };
  }
  const base = process.env.SENTINEL_CONTROL_PLANE_URL;
  const token = process.env.SENTINEL_TOKEN;
  if (base && token) {
    const response = await fetch(`${base.replace(/\/+$/, "")}/v1/sieve/program`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `judge program unavailable (HTTP ${response.status}) - check that your license tier includes the code-review sieve`
      );
    }
    return { program: (await response.json()) as SieveProgram, origin: "control-plane" };
  }
  throw new Error("no judge program: set SIEVE_PROGRAM, or configure SENTINEL_CONTROL_PLANE_URL with SENTINEL_TOKEN");
}

/** Runs the full review protocol for one file or snippet. Throws on entitlement/program/credential failure. */
export async function runCodeReview(
  input: CodeReviewInput,
  deps: { judge?: SieveJudge; verifyOptions?: { publicKeyPem?: string } } = {}
): Promise<CodeReviewResult> {
  requireLicensedFeature(process.env.JVII_TOKEN ?? process.env.JVII_LICENSE_TOKEN, "sieve", {
    // Test/rotation seam only - product verification always uses the embedded issuing key, so
    // nobody can mint their own trust root by exporting an environment variable (LIC-ENV-DOWNGRADE).
    publicKeyPem: deps.verifyOptions?.publicKeyPem,
  });

  const source = input.sourceCode ?? readReviewSource(input.filePath);
  const runs = Math.min(Math.max(input.runs ?? 3, 1), 10);
  const { program, origin } = await loadJudgeProgram();
  const judge: SieveJudge = deps.judge ?? new JevClient({ mode: "live" });

  const summaries = [];
  for (let index = 0; index < runs; index++) {
    // The state is exactly this - never `context`: surrounding architecture steers the judgement.
    const state = { source_code: source, file_path: input.filePath };
    const pass1 = await judge.evaluate(state, questionsFor(program, 1));
    let answers: Record<string, JevAnswer> = pass1.answers;
    const first = summariseRun(program, answers);
    if (!aborted(first) && Object.keys(questionsFor(program, 2)).length > 0) {
      const pass2 = await judge.evaluate(state, questionsFor(program, 2));
      answers = { ...answers, ...pass2.answers };
    }
    summaries.push(summariseRun(program, answers));
  }

  const aggregate = aggregateRuns(summaries);
  const blocked = aggregate.gates.some((gate) => gate.gate.startsWith("abort") && gate.verdict === "fired");
  // `gate_selftest`-style canaries fire whenever scores exist - they prove gates evaluated, not that
  // anything is wrong - so only non-abort, non-canary firings count as refactor warnings.
  const firedWarnings = aggregate.gates.filter(
    (gate) => gate.verdict === "fired" && !gate.gate.startsWith("abort") && !gate.gate.includes("selftest")
  );
  const clean = aggregate.label === "clean_and_idiomatic" && !blocked && firedWarnings.length === 0;
  const verdict = blocked
    ? `completion blocked - fix ${aggregate.label} before commit`
    : clean
      ? "clean - commit granted"
      : `refactor before commit: ${aggregate.strategy ?? "review directives"} (${firedWarnings.map((gate) => gate.gate).join(", ") || aggregate.label})`;

  return {
    file: input.filePath,
    program: origin,
    runs,
    label: aggregate.label,
    agreement: aggregate.agreement,
    confidence: aggregate.confidence,
    complexity: aggregate.complexity,
    hazard: aggregate.hazard,
    urgency: aggregate.urgency,
    strategy: aggregate.strategy,
    gates: aggregate.gates,
    blocked,
    clean,
    verdict,
  };
}
