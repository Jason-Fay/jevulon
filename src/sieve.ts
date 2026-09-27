/**
 * Sieve evaluation library: gate parsing and scorecard aggregation for `*.jev.json` judge programs.
 *
 * Pure functions, no I/O — the CLI runner and the `sentinel_code_review` tool supply answers, the
 * caller's live mode collects them. Written so that gate expressions the program author wrote are
 * either evaluated or reported as `unevaluable` with a reason: silently dropping a gate is how a
 * security abort ends up never firing.
 */
import type { JevAnswer, Question } from "./types.js";

export interface SieveProgram {
  name: string;
  version?: string;
  pass1Questions: Record<string, Question>;
  pass2Questions: Record<string, Question>;
  actionGates: Record<string, string>;
}

export type GateVerdict = "fired" | "clear" | "unevaluable";

export interface GateResult {
  gate: string;
  expression: string;
  verdict: GateVerdict;
  detail: string;
}

export interface SieveRun {
  label: string;
  confidence: number;
  complexity?: number;
  hazard?: number;
  strategy?: string;
  urgency?: number;
  gates: GateResult[];
}

const COMPARISON = /^([A-Za-z_][\w]*)\.(\w+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/;
const EQUALITY = /^([A-Za-z_][\w]*)\.(\w+)\s*===\s*(?:'([^']*)'|"([^"]*)"|(true|false)|(-?\d+(?:\.\d+)?))$/;

function numericField(answer: JevAnswer | undefined, field: string): number | undefined {
  if (!answer) return undefined;
  const value = (answer as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}

/** Evaluates one gate expression against the answers of a single run. */
export function evaluateGate(gate: string, expression: string, answers: Record<string, JevAnswer>): GateResult {
  const comparison = COMPARISON.exec(expression.trim());
  if (comparison) {
    const [, question, field, operator, literalText] = comparison;
    const value = numericField(answers[question], field);
    if (value === undefined) {
      return { gate, expression, verdict: "unevaluable", detail: `${question}.${field} is not comparable (no numeric value)` };
    }
    const threshold = Number(literalText);
    const passed = operator === ">=" ? value >= threshold : operator === "<=" ? value <= threshold : operator === ">" ? value > threshold : value < threshold;
    return { gate, expression, verdict: passed ? "fired" : "clear", detail: `${question}.${field}=${value} ${operator} ${threshold}` };
  }

  const equality = EQUALITY.exec(expression.trim());
  if (equality) {
    const [, question, field, single, double, boolean, numberText] = equality;
    const answer = answers[question];
    if (!answer) return { gate, expression, verdict: "unevaluable", detail: `${question} has no answer` };
    const actual = (answer as Record<string, unknown>)[field];
    const expected = single ?? double ?? (boolean === undefined ? Number(numberText) : boolean === "true");
    const passed = actual === expected;
    return { gate, expression, verdict: passed ? "fired" : "clear", detail: `${question}.${field}=${JSON.stringify(actual)} === ${JSON.stringify(expected)}` };
  }

  return { gate, expression, verdict: "unevaluable", detail: "unrecognised expression (expected `question.field op value` or `question.field === value`)" };
}

/** Turns one set of answers into a run summary. */
export function summariseRun(program: SieveProgram, answers: Record<string, JevAnswer>): SieveRun {
  const smell = answers.primary_smell;
  const gates = Object.entries(program.actionGates ?? {}).map(([gate, expression]) => evaluateGate(gate, expression, answers));
  return {
    label: smell?.choice ?? "unknown",
    confidence: typeof smell?.confidence === "number" ? smell.confidence : 0,
    complexity: numericField(answers.complexity_score, "score"),
    hazard: numericField(answers.security_hazard, "score") ?? numericField(answers.security_hazard, "noul"),
    strategy: answers.refactor_strategy?.choice,
    urgency: numericField(answers.refactor_urgency, "score"),
    gates,
  };
}

export interface SieveAggregate {
  label: string;
  agreement: string;
  confidence: number;
  complexity?: number;
  hazard?: number;
  strategy?: string;
  urgency?: number;
  gates: GateResult[];
}

const mean = (values: Array<number | undefined>): number | undefined => {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0) / present.length;
};

/** Modal label with its agreement, mean scores, and the gates of the first run that evaluated them. */
export function aggregateRuns(runs: SieveRun[]): SieveAggregate {
  if (runs.length === 0) throw new Error("aggregateRuns needs at least one run");
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.label, (counts.get(run.label) ?? 0) + 1);
  const [label, hits] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return {
    label,
    agreement: `${hits}/${runs.length}`,
    confidence: mean(runs.map((run) => run.confidence)) ?? 0,
    complexity: mean(runs.map((run) => run.complexity)),
    hazard: mean(runs.map((run) => run.hazard)),
    strategy: runs[0].strategy,
    urgency: mean(runs.map((run) => run.urgency)),
    gates: runs[0].gates,
  };
}

/** Questions for one pass, in the wire shape the JEV endpoint expects. */
export function questionsFor(program: SieveProgram, pass: 1 | 2): Record<string, Question> {
  return pass === 1 ? (program.pass1Questions ?? {}) : (program.pass2Questions ?? {});
}

/** True when any abort gate fired for this run. */
export function aborted(run: SieveRun): boolean {
  return run.gates.some((gate) => gate.gate.startsWith("abort") && gate.verdict === "fired");
}
