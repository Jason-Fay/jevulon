#!/usr/bin/env node
/**
 * Swarm Sentinel HTTP bridge entry point (plain HTTP/JSON — no MCP, no LangGraph).
 *
 *   swarm-sentinel-bridge --token <t> --engine <module>   custom DecisionEngine (zero JEV calls)
 *   swarm-sentinel-bridge --token <t> [--live|--simulation|--offline]   JEV as the BYOK substrate
 *
 *   --engine <module>   module default-exporting a DecisionEngine (or exporting createEngine())
 *   --host <addr>       bind address (default 127.0.0.1 — loopback; expose deliberately)
 *   --port <n>          bind port (default 8788)
 *   --token <t>         bearer token, repeatable (or SENTINEL_BRIDGE_TOKENS=t1,t2)
 *   --board <path>      presence board file
 *   --agent <id>        presence identity (or SWARM_SENTINEL_AGENT)
 *   --memory <path>     memory file (or SWARM_SENTINEL_MEMORY)
 *
 * Mode flags and memory resolution are shared with the MCP bin (src/mcp/launch.ts). With --engine
 * none of them apply: the caller's engine answers every question, and no JEV call is possible.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { JevClient } from "../client.js";
import type { DecisionEngine } from "../engine.js";
import { createHttpBridge, isDecisionEngine, startBridgeServer } from "../http-bridge.js";
import { parseLaunch, resolveLaunchMode } from "../mcp/launch.js";

function fail(message: string): never {
  process.stderr.write(`[jvii] ${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = ["--engine", "--host", "--port", "--token", "--board", "--agent", "--memory"] as const;
const MODE_FLAGS = ["--simulation", "--live", "--offline"] as const; // parsed by parseLaunch below

const flags: Record<string, string> = {};
const extraTokens: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if ((MODE_FLAGS as readonly string[]).includes(arg)) continue;
  if (!(VALUE_FLAGS as readonly string[]).includes(arg)) fail(`unknown flag: ${arg}`);
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
  i += 1;
  if (arg === "--token") extraTokens.push(value);
  else flags[arg.slice(2)] = value;
}

const launch = parseLaunch(argv, process.env);

const envTokens = (process.env.SENTINEL_BRIDGE_TOKENS ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const issuedTokens = [...extraTokens, ...envTokens];
if (issuedTokens.length === 0) {
  fail("a bearer token is required: --token <t> (repeatable) or SENTINEL_BRIDGE_TOKENS");
}

let engine: DecisionEngine;
const engineModule = flags.engine ?? process.env.SWARM_SENTINEL_ENGINE;
if (engineModule) {
  // Plugin boundary: the engine module is a user-supplied runtime path (`--engine`), so no static
  // import can name it — this is the one place a dynamic import is the only option.
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(path.resolve(engineModule)).href);
  } catch (error) {
    fail(`failed to load engine module ${engineModule}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let candidate: unknown = loaded.default;
  if (candidate === undefined && typeof loaded.createEngine === "function") {
    candidate = loaded.createEngine();
  }
  if (!isDecisionEngine(candidate)) {
    fail(`${engineModule} must default-export a DecisionEngine (choice + noul), or export createEngine() returning one`);
  }
  engine = candidate;
} else {
  // JEV remains the default BYOK substrate (AGENTS.md); --engine swaps it out entirely.
  const resolution = resolveLaunchMode(launch, JevClient.resolveApiKey());
  if (!resolution.ok) fail(resolution.message);
  for (const notice of resolution.notices) process.stderr.write(notice);
  engine = new JevClient({ simulation: resolution.simulation });
}

const port = Number(flags.port ?? process.env.SENTINEL_BRIDGE_PORT ?? "8788");
if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`invalid port: ${flags.port ?? process.env.SENTINEL_BRIDGE_PORT}`);

const bridge = createHttpBridge({
  engine,
  tokens: issuedTokens,
  ...(launch.memoryPath === undefined ? {} : { memoryPath: launch.memoryPath }),
  ...(flags.board === undefined ? {} : { boardPath: flags.board }),
  ...(flags.agent === undefined ? {} : { agentId: flags.agent }),
});

const server = await startBridgeServer(bridge, {
  host: flags.host ?? process.env.SENTINEL_BRIDGE_HOST ?? "127.0.0.1",
  port,
});
process.stderr.write(`[jvii] HTTP bridge listening on ${server.url}\n`);

let shuttingDown = false;
const drain = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  void server.close().then(() => process.exit(0));
};
process.on("SIGTERM", drain);
process.on("SIGINT", drain);
