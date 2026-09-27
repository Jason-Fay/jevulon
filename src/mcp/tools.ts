/**
 * The MCP tool catalogue: names, descriptions, and JSON schemas.
 *
 * Extracted from `server.ts` as data. Descriptions are agent-visible, so they follow the project's
 * claims policy: behaviour only, never a latency number.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listTools(): ToolDefinition[] {
  return [
    {
      name: "sentinel_shield_inspect",
      description:
        "Pre-flight safety inspection for HIGH-RISK, destructive, or irreversible system operations ONLY (e.g. broad deletions, system path wipes, dropping databases, running untrusted remote scripts, or network exfiltration). " +
        "DO NOT call this tool for routine coding: file reads, code edits, git status/diff/log/branch, package installs (npm/bun/pip), or build/test runs - routine development does not require inspection.",
      inputSchema: {
        type: "object",
        properties: {
          commandOrTool: { type: "string", description: "The shell command or tool name about to be executed" },
          arguments: { description: "Optional arguments or payload (bound into the approval fingerprint)" },
          context: { type: "string", description: "Optional situational context" },
        },
        required: ["commandOrTool"],
      },
    },
    {
      name: "sentinel_approve_escalation",
      description:
        "Operator authorization for one escalated action. Approvals are single-use, bound to the exact action payload, and expire. " +
        "Approvals must be attributed: pass approvedBy with your host's operator identity - unattributed approvals, and decisions " +
        "attributed to the identity that requested the escalation, are both refused. " +
        "Configure your MCP host to always require human confirmation for this tool - the server cannot verify who calls it.",
      inputSchema: {
        type: "object",
        properties: {
          actionId: { type: "string", description: "The actionId returned by sentinel_shield_inspect" },
          approved: { type: "boolean", description: "true to authorize execution, false to deny" },
          approvedBy: { type: "string", description: "Identity of whoever is deciding, when your host attributes it (recorded on the decision)" },
          reason: { type: "string", description: "Optional reasoning from the human operator" },
        },
        required: ["actionId", "approved"],
      },
    },
    {
      name: "sentinel_oversight_monitor",
      description: "Evaluates a worker trace for retry loops, deadlocks, and toxic failure patterns (continue / quarantine / reroute / halt).",
      inputSchema: {
        type: "object",
        properties: {
          workerId: { type: "string", description: "ID of the executing worker" },
          action: { type: "string", description: "Action just attempted" },
          outputOrError: { type: "string", description: "Result or error output" },
          recentTrace: { type: "array", items: { type: "string" }, description: "Recent preceding event strings" },
        },
        required: ["workerId", "action", "outputOrError"],
      },
    },
    {
      name: "sentinel_supervise",
      description:
        "Stigmergic task dispatcher backed by the recovery supervisor: `plan` advances a wave, `halt`/`resume` controls execution, " +
        "`fail` records a worker death, `complete` runs the calibrated completion gate, and `classify_circuit` routes a task to the appropriate circuit.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["plan", "assign", "complete", "fail", "add_job", "register_worker", "classify_circuit", "halt", "resume"],
            description: "The supervisor operation to perform",
          },
          jobId: { type: "string", description: "Target job ID" },
          workerId: { type: "string", description: "Target worker ID" },
          title: { type: "string", description: "Job title when adding a job" },
          evidence: { type: "string", description: "Completion evidence/oracle output for the gate" },
          error: { type: "string", description: "Failure reason when recording worker death" },
        },
        required: ["action"],
      },
    },
    {
      name: "sentinel_get_status",
      description: "Returns supervisor state, blackboard counts, pending escalations, and local usage counters.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "sentinel_presence",
      description:
        "Shared presence board for every agent working in this repository (advisory - it never blocks an action). " +
        "Quick usage: " +
        "• Claim files before writing: { action: 'claim', paths: ['src/file.js'], mode: 'edit', note: 'why' }. " +
        "• Release files when done: { action: 'release', paths: ['src/file.js'] }. " +
        "• Checkpoint changes: { action: 'checkpoint' }. " +
        "• Read active board: { action: 'read' }. " +
        "`checkpoint` is the one call to make before an irreversible step. " +
        "`claim` records working paths and reports conflicts; `release` drops your claims. Signals: 'signal'. Directives: 'direct', 'ack', 'resolve'. Atomic queues: 'allocate'. Pheromones: 'alarm', 'attract'.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "checkpoint", "claim", "release", "directives", "ack", "resolve", "direct", "signal", "allocate", "alarm", "attract"],
            description: "Board operation",
          },
          paths: { type: "array", items: { type: "string" }, description: "Repository-relative paths to read, claim, or release" },
          mode: { type: "string", enum: ["edit", "read"], description: "Claim mode (default edit)" },
          note: { type: "string", description: "Why you are in these paths (or a note on an acknowledgement) - other agents inherit this" },
          ttlMinutes: { type: "number", description: "Claim or directive lifetime in minutes (default 15 for claims, 10 for directives; max 1440)" },
          directiveId: { type: "string", description: "Directive to acknowledge or resolve (action: ack / resolve)" },
          agentId: { type: "string", description: "Calling agent identity (defaults to server PID); for 'direct', the target agent to steer" },
          key: { type: "string", description: "Signal/contract key to post (action: signal)" },
          value: { description: "Arbitrary JSON-serializable signal payload (action: signal)" },
          queueKey: { type: "string", description: "Named queue key for atomic item allocation (action: allocate)" },
          items: { type: "array", items: { type: "string" }, description: "Ordered candidate items to allocate from (action: allocate)" },
          kind: { type: "string", enum: ["pause", "reprioritize", "abandon", "handoff"], description: "Directive kind (action: direct)" },
          target: { type: "string", description: "What the directive is about: a path, a job id, or a short description (action: direct)" },
          issuedBy: { type: "string", description: "Who is issuing the directive (action: direct; defaults to the caller)" },
          rationale: { type: "string", description: "Why the directive was issued - the steered agent inherits this" },
        },
        required: ["action"],
      },
    },
    {
      name: "sentinel_code_review",
      description:
        "JEVULON VII Pro code review (Anti-Slop Sieve): audits one file or snippet under the neutral-state " +
        "3-run protocol and returns the modal smell label, complexity (cx) & security hazard (hz) scores, " +
        "gate verdicts, and the refactor directive. Call it before marking a task complete and fix the " +
        "flagged slop first; a fired abort gate means completion is blocked. Requires a Pro/Team license " +
        "token in JVII_TOKEN; the code under review goes only to your own BYOK JEV endpoint (never scraped).",
      inputSchema: {
        type: "object",
        properties: {
          filePath: { type: "string", description: "Path of the file under review (part of the judge state; read from disk when sourceCode is omitted)" },
          sourceCode: { type: "string", description: "The code to audit; when omitted the file at filePath is read" },
          runs: { type: "number", description: "Neutral judge runs (default 3, the project protocol)" },
        },
        required: ["filePath"],
      },
    },
  ];
}
