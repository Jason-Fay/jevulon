/**
 * Deterministic offline policy: the rules that block, escalate, or allow an action without a model.
 *
 * Extracted from `client.ts` so the policy surface has no transport, credential, or circuit-breaker
 * concerns. `bench/corpus.json` is the contract for these rules; the shield runs them as a floor that
 * a model may only tighten.
 */
import type { ShieldVerdict } from "./types.js";

/**
 * Flattens an evaluation state to the raw text the classifier should read.
 * Classifying the JSON-encoded state would double every backslash and distort
 * line-scoped regexes; only genuine string values are considered.
 */
export function flattenStateText(state: unknown): string {
  if (typeof state === "string") return state;
  const parts: string[] = [];
  collectStrings(state, parts);
  return parts.length > 0 ? parts.join("\n") : String(state);
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6) return; // bound recursion so deep or cyclic payloads cannot overflow the stack
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out, depth + 1);
  }
}

export interface SimulatedRisk {
  destructive: boolean;
  ambiguous: boolean;
}

/** A named offline rule. The label travels into audit reasons and MCP responses. */
interface OfflineRule {
  rule: string;
  pattern: RegExp;
}

/**
 * Deterministic offline policy verdict over an action's text.
 * Policy, not model output: the corpus in `bench/corpus.json` pins these rules.
 */
export interface OfflinePolicyVerdict {
  verdict: ShieldVerdict;
  /** Which rule produced the verdict (`no-offline-rule` when nothing matched). */
  rule: string;
}

/**
 * Offline approximation of the blast-radius judgement: covers the documented adversarial corpus
 * (root/home deletion, unicode-folded and base64-/hex-obfuscated payloads, fork bombs, device wipes,
 * pipe-to-shell, credential exfiltration, Windows system cmdlets, structured tool-call arguments,
 * unjudgeable substitution/env-var delete targets) plus the ambiguous cases that should require
 * human confirmation.
 */
export function classifySimulatedAction(text: string): SimulatedRisk {
  const { destructiveRule, ambiguousRule } = matchOfflinePolicy(text);
  return {
    destructive: destructiveRule !== undefined,
    ambiguous: destructiveRule === undefined && ambiguousRule !== undefined,
  };
}

/**
 * The deterministic policy floor, usable on its own (zero egress) or as a veto over a live model.
 * Evaluation order: obfuscation decoding, destructive rules, structured tool-call rules, unjudgeable
 * indirection in destructive positions, ambiguity rules — the first match wins and names itself.
 */
export function classifyOfflinePolicy(state: unknown): OfflinePolicyVerdict {
  const { destructiveRule, ambiguousRule } = matchOfflinePolicy(flattenStateText(state));
  if (destructiveRule !== undefined) return { verdict: "block", rule: destructiveRule };
  if (ambiguousRule !== undefined) return { verdict: "escalate_human", rule: ambiguousRule };
  return { verdict: "allow", rule: "no-offline-rule" };
}

function matchOfflinePolicy(text: string): { destructiveRule?: string; ambiguousRule?: string } {
  // Judge the command as the shell would run it: every rule below reads the resolved text, so
  // unicode folding, IFS word-splitting, and line continuations cannot smuggle a destructive intent
  // past its spelling.
  const resolved = normalizeShellIndirection(text);

  // Decode base64 payloads piped into a shell and re-check the decoded intent.
  for (const match of resolved.matchAll(/echo\s+([A-Za-z0-9+/=]{8,})\s*\|\s*base64\s+-d/gi)) {
    try {
      const decoded = normalizeShellIndirection(Buffer.from(match[1], "base64").toString("utf-8"));
      const rule = matchDestructiveRule(decoded);
      if (rule !== undefined) return { destructiveRule: `base64-decoded ${rule}` };
      const unjudgeableRule = matchUnjudgeableRule(decoded);
      if (unjudgeableRule !== undefined) return { ambiguousRule: `base64-decoded ${unjudgeableRule}` };
    } catch {
      // Not valid base64: fall through to the raw-text checks.
    }
  }

  // Decode printf-style hex escapes and re-check the decoded intent.
  const decoded = decodeHexEscapes(resolved);
  if (decoded !== null) {
    const resolvedDecoded = normalizeShellIndirection(decoded);
    const rule = matchDestructiveRule(resolvedDecoded);
    if (rule !== undefined) return { destructiveRule: `hex-decoded ${rule}` };
    const unjudgeableRule = matchUnjudgeableRule(resolvedDecoded);
    if (unjudgeableRule !== undefined) return { ambiguousRule: `hex-decoded ${unjudgeableRule}` };
  }

  const direct = matchDestructiveRule(resolved);
  if (direct !== undefined) return { destructiveRule: direct };

  const toolRule = matchDestructiveToolCall(resolved);
  if (toolRule !== undefined) return { destructiveRule: toolRule };

  // Unresolvable indirection in a destructive position escalates to a human before any ambiguity
  // rule may soften it — never allow, and never execute the substitution to find out what it runs.
  const unjudgeable = matchUnjudgeableRule(resolved);
  if (unjudgeable !== undefined) return { ambiguousRule: unjudgeable };

  const ambiguous = AMBIGUOUS_RULES.find((candidate) => candidate.pattern.test(resolved));
  if (ambiguous) return { ambiguousRule: ambiguous.rule };
  if (isOutboundToolCallWithSecrets(resolved)) return { ambiguousRule: "outbound-tool-with-credentials" };
  return {};
}

function matchDestructiveRule(text: string): string | undefined {
  if (recursiveForceRmTarget(text) !== null) return "recursive-force-delete-outside-workspace";
  return DESTRUCTIVE_RULES.find((candidate) => candidate.pattern.test(text))?.rule;
}

function matchDestructiveToolCall(text: string): string | undefined {
  return WRITE_TOOL.test(text) && SYSTEM_PATH.test(text) ? "tool-write-system-path" : undefined;
}

/**
 * Resolves bounded shell indirection into the plain command the shell would run: NFKC unicode
 * folding (fullwidth and styled-homoglyph spellings judge as their ASCII intent), `${IFS}`/`$IFS`
 * word splitting, literal tabs, and backslash-newline line continuations. Rules then match by
 * resolved intent rather than obfuscated spelling. Every decode step re-enters this chain, so
 * decoded payloads fold exactly like raw text. Deliberately bounded — residual limits (`$(…)`
 * command substitution and generic `$VAR`/`%VAR%` indirection) are not resolved; where they leave a
 * destructive position unjudgeable they escalate via `matchUnjudgeableRule` instead of guessing.
 */
function normalizeShellIndirection(text: string): string {
  return text
    .normalize("NFKC") // fullwidth/homoglyph spellings fold to their ASCII intent
    .replace(/\\\r?\n/g, "") // backslash-newline joins the continued line
    .replace(/\$\{IFS\}|\$IFS\b/g, " ") // `${IFS}` / `$IFS` expand to the field separator
    .replace(/\t/g, " ") // tab-separated tokens read as space-separated
    .replace(/([A-Za-z0-9_-])['"]([A-Za-z0-9_-]*?)['"]/g, "$1$2") // inline quote-split tokens (`r'm'`, `c"u"rl`)
    .replace(/['"]([A-Za-z0-9_-]+)['"](?=[A-Za-z0-9_-])/g, "$1") // leading quote-split tokens (`'r'm`)
    .replace(/(?:^|(?<=[\s;|&(]))\\?([A-Za-z]{1,4})\\([A-Za-z]{1,6})(?=\s|$)/g, "$1$2"); // intra-token backslash split (`r\m`, `b\ash`)
}

/**
 * Replaces `\xNN` escapes with their bytes and returns the decoded text, or null when the input
 * carries no escape run worth decoding. Requires at least three escapes so incidental sequences
 * are left alone.
 */
function decodeHexEscapes(text: string): string | null {
  const escapes = text.match(/\\x[0-9a-fA-F]{2}/g);
  if (!escapes || escapes.length < 3) return null;
  return text.replace(/\\x[0-9a-fA-F]{2}/g, (match) => String.fromCharCode(parseInt(match.slice(2), 16)));
}

/** Tool names that write bytes to a path. */
const WRITE_TOOL = /\b(?:fs\.write|writeFile(?:Sync)?|write_file|file_write|save_file|apply_patch|copy_file)\b/i;
/** Paths whose modification damages the host rather than the workspace. */
const SYSTEM_PATH = /(?:^|\n)\s*(?:\/(?:etc|bin|sbin|usr|boot|sys|dev|var)\b|[A-Za-z]:\\Windows\b)/m;
/** Tool names that ship a payload to a remote endpoint. */
const OUTBOUND_TOOL = /\b(?:http\.(?:post|put|patch|request)|fetch|requests\.(?:post|put)|axios\.(?:post|put)|webhook|send_webhook)\b/i;
/** Credential-shaped payloads, independent of the surface (shell or structured arguments). */
const CREDENTIAL_PAYLOAD = /(?:AWS_SECRET|SECRET_ACCESS_KEY|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key["']?\s*[:=]|password["']?\s*[:=])/i;
const URL_LITERAL = /https?:\/\//i;


/** Outbound tool calls carrying credential-shaped payloads (e.g. `http.post` with a secret body). */
function isOutboundToolCallWithSecrets(text: string): boolean {
  return OUTBOUND_TOOL.test(text) && URL_LITERAL.test(text) && CREDENTIAL_PAYLOAD.test(text);
}

/** A parsed `rm` invocation: its edge-quote-unwrapped target and the destructive r+f flag pair. */
interface RmInvocation {
  targets: string[];
  recursiveForce: boolean;
}

/** Parses every `rm [flags] <targets...>` invocation across compound shell segments. */
function parseRmInvocations(text: string): RmInvocation[] {
  const invocations: RmInvocation[] = [];
  const pattern = /\brm\s+([^\n|&;]+)/gi;
  for (const match of text.matchAll(pattern)) {
    const tokens = match[1].trim().match(/\$\([^)]*\)|`[^`]*`|\S+/g) ?? [];
    let flags = "";
    const targets: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("--")) {
        const lower = token.toLowerCase();
        if (lower === "--recursive") flags += "r";
        else if (lower === "--force") flags += "f";
      } else if (token.startsWith("-") && token.length > 1) {
        flags += token.slice(1).toLowerCase();
      } else {
        const stripped = token.replace(/^["']+|["']+$/g, "");
        if (stripped.length > 0) targets.push(stripped);
      }
    }
    if (targets.length > 0) {
      invocations.push({
        targets,
        recursiveForce: flags.includes("r") && flags.includes("f"),
      });
    }
  }
  return invocations;
}

/** Returns the first target of any `rm` with both recursive and force flags that points outside the workspace. */
function recursiveForceRmTarget(text: string): string | null {
  for (const invocation of parseRmInvocations(text)) {
    if (!invocation.recursiveForce) continue;
    for (const target of invocation.targets) {
      if (COMMAND_SUBSTITUTION.test(target)) continue;
      const outsideWorkspace =
        target === "/" ||
        target.startsWith("/") ||
        target.startsWith("~") ||
        HOME_ENV.test(target) ||
        /^[A-Za-z]:/.test(target) ||
        target.startsWith("\\\\") ||
        target.includes("..");
      if (outsideWorkspace) return target;
    }
  }
  return null;
}

/** Command substitution (`$(…)` or backticks): its output cannot be judged without executing it. */
const COMMAND_SUBSTITUTION = /\$\(|`/;
/** An env-var reference in a target slot (`$VAR`, `${VAR}`, `%VAR%`), beyond the resolved home forms. */
const ENV_TARGET = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|%[A-Za-z_][A-Za-z0-9_]*%|\$[A-Za-z_][A-Za-z0-9_]*)/;
/** Destructive shape of a command line: delete-style flags or a verb that destroys data or the host. */
const DESTRUCTIVE_SHAPE =
  /\s--?(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b|\b(?:rm|del|erase|rd|rmdir|shred|truncate|dd|mkfs|wipefs|fdisk|chmod|Remove-Item|Clear-Disk|Format-Volume|format)\b/i;
/** A substitution standing in for the command itself at a command boundary. */
const SUBSTITUTION_COMMAND_HEAD = /(?:^|[;&|(])\s*(?:\$\(|`)/;

/**
 * Unresolvable indirection in a destructive position: the verdict is `escalate_human`, never
 * `allow`, and the substitution is never executed to find out what it would have run.
 */
function matchUnjudgeableRule(text: string): string | undefined {
  for (const invocation of parseRmInvocations(text)) {
    for (const target of invocation.targets) {
      if (COMMAND_SUBSTITUTION.test(target)) return "unjudgeable-substitution";
      if (!HOME_ENV.test(target) && ENV_TARGET.test(target)) return "unjudgeable-env-target";
    }
  }
  for (const line of text.split("\n")) {
    if (SUBSTITUTION_COMMAND_HEAD.test(line) && DESTRUCTIVE_SHAPE.test(line)) return "unjudgeable-substitution";
  }
  return undefined;
}

/** Env-var prefixes that resolve to the user's home (`$HOME`, `${HOME}`, `%USERPROFILE%`, …). */
const HOME_ENV = /^\$(?:HOME|\{HOME\})|^%(?:USERPROFILE|HOMEPATH|HOMEDRIVE)%/i;

const DESTRUCTIVE_RULES: OfflineRule[] = [
  { rule: "device-write-dd", pattern: /dd\s+[^\n]*of=\/dev\//i },
  {
    rule: "inline-script-host-wipe",
    pattern: /\b(?:rmSync|rmdirSync|rmtree)\s*\(\s*["'](?:\/|~|\.\.|[A-Za-z]:\\)/i,
  },
  { rule: "filesystem-format-or-wipe", pattern: /\bmkfs|\bwipefs|\bfdisk\s+\/dev/i },
  { rule: "fork-bomb", pattern: /:\s*\(\s*\)\s*\{[^\n]*\|[^\n]*&[^\n]*\}/ },
  { rule: "world-writable-root", pattern: /chmod\s+-R\s+777\s+\//i },
  // Command-position anchor: "shutdown" as a word in prose must not fire this rule (the corpus pins
  // two benign strings); only a power command at the head of a command does. PowerShell `Stop-`/
  // `Restart-Computer` keep firing `powershell-host-control` below.
  {
    rule: "host-shutdown",
    pattern: /(?:^|[\n;&|(`])\s*(?:sudo\s+)?(?:systemctl\s+)?(?:shutdown|poweroff)\b/im,
  },
  { rule: "pipe-to-shell", pattern: /\b(curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i },
  { rule: "powershell-recursive-delete", pattern: /Remove-Item[^\n]*-(?:Recurse|Force)[^\n]*(?:[A-Za-z]:\\|\\\\|\/(?:Users|Windows)\b|\$env:USERPROFILE|\$HOME|~)/i },
  { rule: "cmd-delete-drive", pattern: /\b(?:del|erase)\s+(?:\/[a-z]\s*)+[A-Za-z]:\\/i },
  { rule: "cmd-tree-removal", pattern: /\b(?:rd|rmdir)\s+(?:\/[a-z]\s*)+[A-Za-z]:\\/i },
  { rule: "powershell-host-control", pattern: /\b(?:Stop|Restart)-Computer\b/i },
  { rule: "powershell-storage-wipe", pattern: /\b(?:Clear-Disk|Format-Volume)\b/i },
  { rule: "windows-format", pattern: /\bformat\s+[A-Za-z]:/i },
  { rule: "mass-delete-find", pattern: /\bfind\s+\/[^\n]*-delete\b/i },
  { rule: "system-file-destroy", pattern: /\b(?:truncate|shred)\b[^\n]*\s\/(?:etc|var|usr|bin|sbin|boot|dev)\b/i },
  {
    rule: "credential-exfiltration-pipe",
    pattern: /(?:id_rsa|\.ssh\/|\.aws\/credentials|\/etc\/shadow|\/etc\/passwd|\benv\b|\bprintenv\b|\bexport\s+-p\b)[^\n]*\|\s*(?:curl|nc|wget|ncat)\b/i,
  },
  {
    rule: "upload-exfiltration",
    pattern: /\b(?:curl|wget)\b[^\n]*(?:-F|--form|--post-file|--upload-file|\s-T\b)[^\n]*(?:@|\/etc\/|\/root\/|\.ssh|\.aws)/i,
  },
  {
    rule: "transfer-exfiltration",
    pattern: /\b(?:scp|rsync)\b[^\n]*(?:~\/\.ssh|~\/\.aws|id_rsa|\/etc\/(?:shadow|passwd)|\.env\b|\/home\/\w+\/\.(?:ssh|aws))[^\n]*\s\S+@\S+/i,
  },
  {
    rule: "transfer-of-credentials",
    pattern: /\b(?:scp|rsync)\b[^\n]*\s\S+@\S+:[^\n]*(?:\/etc\/|\.ssh|\.aws|id_rsa)/i,
  },
];

const AMBIGUOUS_RULES: OfflineRule[] = [
  { rule: "git-clean-untracked", pattern: /\bgit\s+clean\s+-[a-z]*[dfx]/i },
  { rule: "git-reset-hard", pattern: /\bgit\s+reset\s+--hard\b/i },
  { rule: "git-force-push", pattern: /\bgit\s+push\b[^\n]*--force\b/i },
  { rule: "docker-volume-teardown", pattern: /\bdocker\s+compose\s+down\b[^\n]*(?:-v\b|--volumes)/i },
  { rule: "docker-volume-rm", pattern: /\bdocker\s+volume\s+rm\b/i },
  { rule: "docker-prune-volumes", pattern: /\bdocker\s+system\s+prune\b[^\n]*--volumes/i },
];
