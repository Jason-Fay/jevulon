/**
 * HTTP bridge: a standalone, non-MCP, non-LangGraph transport for the SAME tool handlers the MCP
 * server exposes.
 *
 * Harness-neutrality demonstrated rather than asserted: a plain HTTP caller (CrewAI, AutoGen, a curl
 * script) drives coordinator + supervisor end to end on a caller-supplied {@link DecisionEngine} with
 * zero JEV calls, and a hostile payload meets the deterministic offline floor exactly as
 * `bench/corpus.json` requires — the floor short-circuits before the engine is ever consulted.
 *
 * Every call crosses the same `callTool`/`validate.ts` boundary as MCP: there is no second tool
 * surface and no second validation vocabulary. An `isError` tool result is passed through verbatim as
 * `{ error: <the boundary's own message> }`; the HTTP layer adds only transport concerns (bearer
 * tokens, a body cap, status codes), mirroring `server/control-plane.ts`.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { JevClient } from "./client.js";
import { JevUnavailableError } from "./errors.js";
import type { DecisionEngine } from "./engine.js";
import { McpServer } from "./mcp/server.js";
import type { JevAnswer, JevEvaluationResult, QuestionsMap } from "./types.js";

/**
 * Adapts a caller's {@link DecisionEngine} to the evaluation surface every tool handler shares, so
 * the MCP tool handlers run with zero JEV calls: `evaluate` replaces the JEV transport outright (no
 * request can ever be built, so neither the network nor the simulator is reachable), choice and noul
 * questions go to the engine verbatim, and a score question is asked as the engine's own typed menu
 * over the question's numbered bands. A malformed engine answer fails closed with the same typed
 * error the real client raises, so every downstream fail-closed path behaves identically.
 */
export class DecisionEngineClient extends JevClient {
  private readonly decisionEngine: DecisionEngine;

  constructor(decisionEngine: DecisionEngine) {
    // Live mode on purpose: the deterministic policy floor short-circuits a hostile action before any
    // engine call ("no cost, no egress"), exactly as it does for a live JEV client. The dummy
    // credential is never spent — evaluate below replaces the transport entirely.
    super({ mode: "live", apiKey: "decision-engine", model: "custom-engine" });
    this.decisionEngine = decisionEngine;
  }

  public override async evaluate(state: unknown, questions: QuestionsMap): Promise<JevEvaluationResult> {
    const startedAt = Date.now();
    const answers: Record<string, JevAnswer> = {};

    for (const [key, question] of Object.entries(questions)) {
      if (question.type === "choice") {
        const res = await this.decisionEngine.choice(state, question.instructions, question.criteria);
        if (typeof res.choice !== "string" || res.choice.length === 0) {
          throw new JevUnavailableError(`decision engine returned a malformed "${key}" choice answer; failing closed.`);
        }
        answers[key] = {
          choice: res.choice,
          confidence: res.confidence,
          ...(res.probabilities === undefined ? {} : { probabilities: res.probabilities }),
        };
      } else if (question.type === "noul") {
        const res = await this.decisionEngine.noul(state, question.instructions);
        if (typeof res.noul !== "number" || !Number.isFinite(res.noul)) {
          throw new JevUnavailableError(`decision engine returned a malformed "${key}" noul answer; failing closed.`);
        }
        answers[key] = { noul: res.noul, confidence: res.confidence };
      } else {
        // A score question becomes the engine's typed menu over the question's own numbered bands
        // ("0: …", "1: …", …); the chosen band index is the score.
        const bands: Record<string, string> = {};
        question.criteria.forEach((band, index) => {
          bands[String(index)] = band;
        });
        const res = await this.decisionEngine.choice(state, question.instructions, bands);
        const score = Number(res.choice);
        if (!Number.isInteger(score) || score < 0 || score >= question.criteria.length) {
          throw new JevUnavailableError(`decision engine returned a malformed "${key}" score answer; failing closed.`);
        }
        answers[key] = { score, confidence: res.confidence };
      }
    }

    return { answers, latencyMs: Date.now() - startedAt, model: this.modelName };
  }
}

/** Runtime shape check at module-loading boundaries (the bin imports engines from user modules). */
export function isDecisionEngine(value: unknown): value is DecisionEngine {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { choice?: unknown; noul?: unknown };
  return typeof candidate.choice === "function" && typeof candidate.noul === "function";
}

export interface HttpBridgeOptions {
  /**
   * The caller's custom decision engine — every question the tool handlers ask is answered by it.
   * `JevClient` satisfies `DecisionEngine` structurally, so JEV remains available as the default BYOK
   * substrate; anything else runs with zero JEV calls.
   */
  engine: DecisionEngine;
  /** Issued bridge tokens. Only SHA-256 digests are retained. */
  tokens?: Iterable<string>;
  memoryPath?: string;
  /** Explicit presence-board file; otherwise resolved from the repository layout (shared by worktrees). */
  boardPath?: string;
  /** Identity recorded on the board; defaults to `SWARM_SENTINEL_AGENT` or `http#<pid>`. */
  agentId?: string;
  /** How long a pending escalation stays answerable (default 15 minutes). */
  escalationTtlMs?: number;
  /** Request body cap in bytes, enforced before JSON parsing (default 64 KB). */
  maxBodyBytes?: number;
}

export interface HttpBridge {
  /** The adapter itself: a plain `Request -> Response` handler (embed it in Bun.serve, node:http, or a worker). */
  fetch: (request: Request) => Promise<Response>;
  registerToken: (token: string) => void;
  revokeToken: (token: string) => void;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The bridge routes one tool call per request:
 *
 *   POST /v1/tool   { "name": "<sentinel tool>", "arguments": { ... } } -> the tool's JSON result
 *   GET  /v1/tools  the same tool catalogue MCP serves (discovery for non-MCP callers)
 *   GET  /healthz   liveness, no token (control-plane parity)
 *
 * Token auth and the body cap mirror `server/control-plane.ts`; the tool envelope's coercion mirrors
 * the MCP `tools/call` path, so both transports cannot drift apart.
 */
export function createHttpBridge(options: HttpBridgeOptions): HttpBridge {
  const server = new McpServer({
    client: new DecisionEngineClient(options.engine),
    ...(options.memoryPath === undefined ? {} : { memoryPath: options.memoryPath }),
    ...(options.boardPath === undefined ? {} : { boardPath: options.boardPath }),
    agentId: options.agentId ?? process.env.SWARM_SENTINEL_AGENT ?? `http#${process.pid}`,
    ...(options.escalationTtlMs === undefined ? {} : { escalationTtlMs: options.escalationTtlMs }),
  });
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const issued = new Set<string>(); // token digests only, mirroring the control plane
  for (const token of options.tokens ?? []) issued.add(sha256Hex(token));

  function authorized(request: Request): boolean {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) return false;
    return issued.has(sha256Hex(header.slice("Bearer ".length).trim()));
  }

  async function handleToolCall(request: Request): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > maxBodyBytes) return json(413, { error: "payload too large" });

    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maxBodyBytes) return json(413, { error: "payload too large" });

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "invalid JSON body" });
    }

    const params = body as Record<string, unknown>;
    // The same envelope coercion as the MCP `tools/call` path (src/mcp/server.ts) — one boundary.
    const name = typeof params.name === "string" ? params.name : "";
    const rawArguments = params.arguments;
    const args =
      rawArguments !== undefined && rawArguments !== null && typeof rawArguments === "object"
        ? Object.fromEntries(Object.entries(rawArguments))
        : {};

    const result = await server.callTool(name, args);
    const resultText = result.content[0]?.text ?? "";
    if (result.isError) return json(400, { error: resultText });

    try {
      return json(200, JSON.parse(resultText) as unknown);
    } catch {
      return json(500, { error: "tool result was not JSON" });
    }
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return json(200, { ok: true });
    if (!authorized(request)) return json(401, { error: "unauthorized" });
    if (url.pathname === "/v1/tools") {
      if (request.method !== "GET") return json(405, { error: "method not allowed" });
      return json(200, { tools: server.getToolsList() });
    }
    if (url.pathname === "/v1/tool") return handleToolCall(request);
    return json(404, { error: "not found" });
  }

  return {
    fetch: (request: Request) => route(request),
    registerToken: (token: string) => {
      issued.add(sha256Hex(token));
    },
    revokeToken: (token: string) => {
      issued.delete(sha256Hex(token));
    },
  };
}

export interface BridgeServerOptions {
  /** Bind address. Defaults to 127.0.0.1: the bridge is a local adapter surface, exposed deliberately. */
  host?: string;
  /** Bind port. Default 0 (an ephemeral port); the bin supplies its product default. */
  port?: number;
  /** Body cap at the socket layer (default 64 KB) — the origin backstop behind any reverse proxy. */
  maxBodyBytes?: number;
}

export interface BridgeServer {
  /** e.g. `http://127.0.0.1:8788` */
  url: string;
  /** The address the socket is actually bound to — loopback unless a host was passed explicitly. */
  host: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Serves the bridge on a real `node:http` socket (Node and Bun alike). Loopback by default — the
 * same posture as `server/main.ts`: exposure happens through a reverse proxy or an explicit host,
 * never by accident.
 */
export function startBridgeServer(bridge: HttpBridge, options: BridgeServerOptions = {}): Promise<BridgeServer> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;

    request.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      size += chunk.length;
      chunks.push(chunk);
      if (size > maxBodyBytes) {
        // Origin backstop (the Bun.serve `maxRequestBodySize` analogue): answer, and drop the socket
        // only once the response has flushed, before a runaway body can be buffered any further.
        overflowed = true;
        chunks.length = 0;
        response.statusCode = 413;
        response.setHeader("content-type", "application/json");
        response.setHeader("connection", "close");
        response.end(JSON.stringify({ error: "payload too large" }), () => request.destroy());
      }
    });

    request.on("end", () => {
      if (overflowed) return;
      void (async () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, entry);
        }
        const method = request.method ?? "GET";
        try {
          const incoming = new Request(`http://${options.host ?? "127.0.0.1"}${request.url ?? "/"}`, {
            method,
            headers,
            ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
          });
          const result = await bridge.fetch(incoming);
          response.statusCode = result.status;
          result.headers.forEach((value, key) => response.setHeader(key, value));
          response.end(Buffer.from(await result.arrayBuffer()));
        } catch (error) {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      })();
    });
  });

  return new Promise<BridgeServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const urlHost = address.address.includes(":") ? `[${address.address}]` : address.address;
      resolve({
        url: `http://${urlHost}:${address.port}`,
        host: address.address,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
