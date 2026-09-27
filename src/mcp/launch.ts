/**
 * Launch-mode resolution for the stdio MCP server.
 *
 * Pure decision logic, kept out of the executable so it can be unit-tested: the bin maps a
 * non-`ok` resolution to `process.exit(2)` after writing the message to stderr.
 */

export interface LaunchOptions {
  mode: "auto" | "live" | "simulation";
  /** True when zero-egress was requested explicitly (`--offline` / `SWARM_SENTINEL_MODE=offline`). */
  offline: boolean;
  memoryPath?: string;
}

export type LaunchResolution =
  | { ok: true; simulation: boolean; notices: string[] }
  | { ok: false; message: string };

export function parseLaunch(argv: string[], env: NodeJS.ProcessEnv): LaunchOptions {
  const wantsOffline = argv.includes("--offline") || env.SWARM_SENTINEL_MODE === "offline";
  const modeFlag = argv.includes("--simulation") || wantsOffline
    ? "simulation"
    : argv.includes("--live")
      ? "live"
      : undefined;
  const envMode = env.SWARM_SENTINEL_MODE === "simulation" || env.SWARM_SENTINEL_MODE === "live" ? env.SWARM_SENTINEL_MODE : undefined;
  const memoryFlagIndex = argv.indexOf("--memory");
  const memoryPath = memoryFlagIndex >= 0 && argv[memoryFlagIndex + 1] ? argv[memoryFlagIndex + 1] : env.SWARM_SENTINEL_MEMORY;
  return {
    mode: modeFlag ?? envMode ?? "auto",
    offline: wantsOffline,
    ...(memoryPath === undefined ? {} : { memoryPath }),
  };
}

/**
 * Resolves the evaluation mode. Explicit `--live` without a credential is fatal (never fabricate
 * safety verdicts); auto mode without one falls back to simulation with a loud notice.
 */
export function resolveLaunchMode(options: LaunchOptions, credential: string): LaunchResolution {
  if (options.mode === "live") {
    if (!credential) {
      return { ok: false, message: "--live requires a credential: set TYPESAFE_API_KEY / JEV_API_KEY, or run with --simulation." };
    }
    return { ok: true, simulation: false, notices: [] };
  }

  if (options.mode === "simulation") {
    return {
      ok: true,
      simulation: true,
      notices: options.offline
        ? ["[jvii] OFFLINE mode: zero egress — verdicts come from the deterministic policy floor, no API calls.\n"]
        : [],
    };
  }

  if (credential) return { ok: true, simulation: false, notices: [] };

  return {
    ok: true,
    simulation: true,
    notices: [
      "[jvii] no credential found — running in SIMULATION (deterministic, no API calls). " +
        "Set TYPESAFE_API_KEY for live evaluation, or pass --simulation to silence this notice.\n",
    ],
  };
}
