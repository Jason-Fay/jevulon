#!/usr/bin/env node
/**
 * JEVULON VII (JVII) MCP server entry point (stdio).
 *
 *   npx jevulon / npx jvii             auto: live with a credential, simulation without one (loud banner)
 *   npx jevulon --simulation           deterministic simulation, never calls the network
 *   npx jevulon --offline              same engine, announced as zero-egress (for compliance configs)
 *   npx jevulon --live                 require a credential; exits 2 if none is configured
 *   npx jevulon --memory <path>        override the .jevulon/memory.json location
 *
 * Environment: JEVULON_MODE=simulation|live|offline, JEVULON_MEMORY=<path>
 *
 * Mode resolution lives in ./launch.js (pure, unit-tested); this file is the process shell.
 */
import { JevClient } from "../client.js";
import { McpServer } from "../mcp/server.js";
import { parseLaunch, resolveLaunchMode } from "../mcp/launch.js";

function fail(message: string): never {
  process.stderr.write(`[jvii] ${message}\n`);
  process.exit(2);
}

const launch = parseLaunch(process.argv.slice(2), process.env);
const resolution = resolveLaunchMode(launch, JevClient.resolveApiKey());

if (!resolution.ok) {
  fail(resolution.message);
}
for (const notice of resolution.notices) {
  process.stderr.write(notice);
}

try {
  const server = new McpServer({ simulation: resolution.simulation, memoryPath: launch.memoryPath });
  server.startStdio();
} catch (error) {
  fail(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
}
