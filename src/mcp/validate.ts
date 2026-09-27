/**
 * Runtime validation for MCP tool arguments.
 * MCP input is untrusted JSON: nothing reaches a handler without shape checking, and a
 * wrong-typed field is an error — never a truthiness coercion (a string "false" is not approval).
 */

export class ToolInputError extends Error {
  constructor(
    public tool: string,
    public field: string,
    message: string
  ) {
    super(`[${tool}] ${message}`);
    this.name = "ToolInputError";
  }
}

const MAX_STRING = 10_000;
const MAX_TRACE_ENTRIES = 50;
const MAX_TRACE_ENTRY = 2_000;

function requireString(tool: string, args: Record<string, unknown>, field: string, max = MAX_STRING): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(tool, field, `${field} must be a non-empty, non-whitespace string`);
  }
  if (value.length > max) {
    throw new ToolInputError(tool, field, `${field} exceeds ${max} characters`);
  }
  return value;
}

function optionalString(tool: string, args: Record<string, unknown>, field: string, max = MAX_STRING): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError(tool, field, `${field} must be a string when provided`);
  }
  if (value.length > max) {
    throw new ToolInputError(tool, field, `${field} exceeds ${max} characters`);
  }
  return value;
}

function requireBoolean(tool: string, args: Record<string, unknown>, field: string): boolean {
  const value = args[field];
  if (typeof value !== "boolean") {
    throw new ToolInputError(tool, field, `${field} must be a boolean (a string like "false" is not accepted)`);
  }
  return value;
}

export interface InspectToolArgs {
  commandOrTool: string;
  arguments?: unknown;
  context?: string;
}

export interface CodeReviewToolArgs {
  filePath: string;
  sourceCode?: string;
  runs?: number;
}

export function validateCodeReviewArgs(tool: string, args: Record<string, unknown>): CodeReviewToolArgs {
  const runs = args.runs;
  if (runs !== undefined && (typeof runs !== "number" || !Number.isFinite(runs) || runs < 1)) {
    throw new ToolInputError(tool, "runs", "runs must be a positive number when provided");
  }
  return {
    filePath: requireString(tool, args, "filePath", 512),
    sourceCode: optionalString(tool, args, "sourceCode", 200_000),
    runs,
  };
}

export function validateInspectArgs(tool: string, args: Record<string, unknown>): InspectToolArgs {
  const context = optionalString(tool, args, "context");
  return {
    commandOrTool: requireString(tool, args, "commandOrTool"),
    ...(args.arguments === undefined ? {} : { arguments: args.arguments }),
    ...(context === undefined ? {} : { context }),
  };
}

export interface ApproveToolArgs {
  actionId: string;
  approved: boolean;
  reason?: string;
}

export function validateApproveArgs(tool: string, args: Record<string, unknown>): ApproveToolArgs {
  const reason = optionalString(tool, args, "reason");
  return {
    actionId: requireString(tool, args, "actionId", 128),
    approved: requireBoolean(tool, args, "approved"),
    ...(reason === undefined ? {} : { reason }),
  };
}

export interface MonitorToolArgs {
  workerId: string;
  action: string;
  outputOrError: string;
  recentTrace?: string[];
}

export function validateMonitorArgs(tool: string, args: Record<string, unknown>): MonitorToolArgs {
  const trace = args.recentTrace;
  if (trace !== undefined && !Array.isArray(trace)) {
    throw new ToolInputError(tool, "recentTrace", "recentTrace must be an array of strings when provided");
  }
  const recentTrace = trace === undefined
    ? undefined
    : trace.slice(-MAX_TRACE_ENTRIES).map((entry, index) => {
        if (typeof entry !== "string") {
          throw new ToolInputError(tool, `recentTrace[${index}]`, "recentTrace entries must be strings");
        }
        return entry.length > MAX_TRACE_ENTRY ? entry.slice(0, MAX_TRACE_ENTRY) : entry;
      });

  return {
    workerId: requireString(tool, args, "workerId", 256),
    action: requireString(tool, args, "action", 256),
    outputOrError: requireString(tool, args, "outputOrError"),
    ...(recentTrace === undefined ? {} : { recentTrace }),
  };
}

export const SUPERVISE_ACTIONS = ["plan", "assign", "complete", "fail", "add_job", "register_worker", "classify_circuit", "halt", "resume"] as const;
export type SuperviseAction = (typeof SUPERVISE_ACTIONS)[number];

export interface SuperviseToolArgs {
  action: SuperviseAction;
  jobId?: string;
  workerId?: string;
  title?: string;
  evidence?: string;
  error?: string;
}

export function validateSuperviseArgs(tool: string, args: Record<string, unknown>): SuperviseToolArgs {
  const action = args.action;
  if (typeof action !== "string" || !(SUPERVISE_ACTIONS as readonly string[]).includes(action)) {
    throw new ToolInputError(tool, "action", `action must be one of: ${SUPERVISE_ACTIONS.join(", ")}`);
  }
  const jobId = optionalString(tool, args, "jobId", 256);
  const workerId = optionalString(tool, args, "workerId", 256);
  const title = optionalString(tool, args, "title");
  const evidence = optionalString(tool, args, "evidence");
  const error = optionalString(tool, args, "error");
  return {
    action: action as SuperviseAction, // membership checked against the literal list above
    ...(jobId === undefined ? {} : { jobId }),
    ...(workerId === undefined ? {} : { workerId }),
    ...(title === undefined ? {} : { title }),
    ...(evidence === undefined ? {} : { evidence }),
    ...(error === undefined ? {} : { error }),
  };
}

export const PRESENCE_ACTIONS = ["read", "checkpoint", "claim", "release", "directives", "ack", "resolve", "direct", "signal", "allocate", "alarm", "attract"] as const;
export const DIRECTIVE_KINDS = ["pause", "reprioritize", "abandon", "handoff"] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];
export type PresenceAction = (typeof PRESENCE_ACTIONS)[number];

export interface PresenceToolArgs {
  action: PresenceAction;
  /** Repository-relative paths to read, claim, or release. */
  paths?: string[];
  mode?: "edit" | "read";
  /** Why the agent is in these paths — travels to every other agent that reads the board. */
  note?: string;
  /** Claim, directive, and signal lifetime in minutes (max 1440); signals default to 15. */
  ttlMinutes?: number;
  /** Directive being acknowledged or resolved. */
  directiveId?: string;
  /** The agent a directive steers (action: direct). */
  agentId?: string;
  kind?: DirectiveKind;
  /** What a directive is about: a path, a job id, or a short description. */
  target?: string;
  /** Who issued a directive (a human or an agent id). */
  issuedBy?: string;
  /** The reason a directive was issued — the agent inherits it. */
  rationale?: string;
  /** Named signal key (action: signal). */
  key?: string;
  /** Arbitrary JSON-serializable signal payload (action: signal). */
  value?: unknown;
  /** Named queue key for atomic allocation (action: allocate). */
  queueKey?: string;
  /** Ordered candidate items to allocate from (action: allocate). */
  items?: string[];
}

const MAX_PATHS = 100;

export function validatePresenceArgs(tool: string, args: Record<string, unknown>): PresenceToolArgs {
  let action = typeof args.action === "string" ? args.action.toLowerCase().trim() : undefined;
  if (!action || action === "query" || action === "status" || action === "list" || action === "view" || action === "check" || action === "inspect") {
    action = args.paths !== undefined && Array.isArray(args.paths) && args.paths.length > 0 ? "claim" : "read";
  }
  if (action === "report") {
    action = "signal";
  }
  if (!(PRESENCE_ACTIONS as readonly string[]).includes(action)) {
    throw new ToolInputError(tool, "action", `action must be one of: ${PRESENCE_ACTIONS.join(", ")}`);
  }

  const rawPaths = args.paths;
  if (rawPaths !== undefined && !Array.isArray(rawPaths)) {
    throw new ToolInputError(tool, "paths", "paths must be an array of strings when provided");
  }
  const paths = rawPaths === undefined
    ? undefined
    : (rawPaths as unknown[]).slice(0, MAX_PATHS).map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new ToolInputError(tool, `paths[${index}]`, "paths entries must be non-empty strings");
        }
        if (entry.length > 512) {
          throw new ToolInputError(tool, `paths[${index}]`, "paths entries must be at most 512 characters");
        }
        return entry;
      });

  const mode = args.mode;
  if (mode !== undefined && mode !== "edit" && mode !== "read") {
    throw new ToolInputError(tool, "mode", 'mode must be "edit" or "read" when provided');
  }

  const note = optionalString(tool, args, "note", 1000);

  const ttl = args.ttlMinutes;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0 || ttl > 1440)) {
    throw new ToolInputError(tool, "ttlMinutes", "ttlMinutes must be a positive number of minutes (max 1440)");
  }

  if ((action === "ack" || action === "resolve") && typeof args.directiveId !== "string") {
    throw new ToolInputError(tool, "directiveId", `directiveId is required for ${action}`);
  }
  const kind = args.kind;
  if (action === "direct" && (typeof kind !== "string" || !(DIRECTIVE_KINDS as readonly string[]).includes(kind))) {
    throw new ToolInputError(tool, "kind", `kind must be one of: ${DIRECTIVE_KINDS.join(", ")}`);
  }
  if (action === "direct" && typeof args.target !== "string") {
    throw new ToolInputError(tool, "target", "target is required for direct");
  }
  if (action === "direct" && typeof args.agentId !== "string") {
    throw new ToolInputError(tool, "agentId", "agentId (the agent to steer) is required for direct");
  }
  if (action === "signal" && (typeof args.key !== "string" || !args.key.trim())) {
    throw new ToolInputError(tool, "key", "key is required for signal action");
  }
  const rawItems = args.items;
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new ToolInputError(tool, "items", "items must be an array of strings when provided");
  }
  const items = rawItems === undefined
    ? undefined
    : (rawItems as unknown[]).slice(0, 500).map((entry, index) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new ToolInputError(tool, `items[${index}]`, "items entries must be non-empty strings");
        }
        if (entry.length > 512) {
          throw new ToolInputError(tool, `items[${index}]`, "items entries must be at most 512 characters");
        }
        return entry;
      });
  const queueKey = optionalString(tool, args, "queueKey", 256);
  if (action === "allocate" && (!queueKey || !items || items.length === 0)) {
    throw new ToolInputError(tool, "allocate", "queueKey and non-empty items array are required for allocate");
  }

  return {
    action: action as PresenceAction,
    ...(args.directiveId === undefined ? {} : { directiveId: requireString(tool, args, "directiveId", 128) }),
    ...(args.agentId === undefined ? {} : { agentId: requireString(tool, args, "agentId", 256) }),
    ...(kind === undefined ? {} : { kind: kind as DirectiveKind }),
    ...(args.target === undefined ? {} : { target: requireString(tool, args, "target", 512) }),
    ...(args.issuedBy === undefined ? {} : { issuedBy: requireString(tool, args, "issuedBy", 256) }),
    ...(args.rationale === undefined ? {} : { rationale: optionalString(tool, args, "rationale", 1000) }),
    ...(paths === undefined ? {} : { paths }),
    ...(mode === undefined ? {} : { mode }),
    ...(note === undefined ? {} : { note }),
    ...(ttl === undefined ? {} : { ttlMinutes: ttl }),
    ...(args.key === undefined ? {} : { key: requireString(tool, args, "key", 256) }),
    ...(args.value === undefined ? {} : { value: args.value }),
    ...(queueKey === undefined ? {} : { queueKey }),
    ...(items === undefined ? {} : { items }),
  };
}
