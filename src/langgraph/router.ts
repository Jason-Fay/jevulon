import { JevClient } from "../client.js";
import { TelemetryCollector } from "../telemetry.js";
import type { ProjectMemory } from "../memory.js";
import { InvalidJevAnswerError, JevUnavailableError } from "../errors.js";

export interface JevRouterOptions<TState> {
  client?: JevClient;
  telemetry?: TelemetryCollector;
  /** Client-side project memory: routing decisions are counted into the usage file. */
  memory?: ProjectMemory;
  tenantId?: string;
  instructions: string;
  routes: Record<string, string>; // e.g. { coder: "Writes code", reviewer: "Audits security", end: "Complete" }
  stateExtractor?: (state: TState) => string | object;
  /**
   * Route key used when JEV answers outside `routes` or the endpoint is unavailable.
   * Without it, an out-of-vocabulary answer throws InvalidJevAnswerError instead of
   * surfacing LangGraph's cryptic "unknown destination" crash.
   */
  fallbackRoute?: string;
}

/**
 * Creates a LangGraph conditional edge routing function powered by TypeSafe JEV.
 * Evaluates state and routes in ~280ms with $0.00 output tokens.
 */
export function createJevRouter<TState = unknown>(options: JevRouterOptions<TState>) {
  const client = options.client || new JevClient();
  const telemetry = options.telemetry || new TelemetryCollector();
  const tenantId = options.tenantId || "default_tenant";
  const routeKeys = Object.keys(options.routes);

  if (options.fallbackRoute !== undefined && !routeKeys.includes(options.fallbackRoute)) {
    throw new Error(`fallbackRoute "${options.fallbackRoute}" is not one of the declared routes (${routeKeys.join(", ")})`);
  }

  return async (state: TState): Promise<string> => {
    // LangGraph state is always an object; TState stays unconstrained for ergonomics.
    const extractedState: string | object = options.stateExtractor ? options.stateExtractor(state) : (state as object);

    const t0 = Date.now();
    let choice = "";
    let confidence = 0;
    let degraded = false;

    try {
      const res = await client.choice(extractedState, options.instructions, options.routes);
      choice = res.choice;
      confidence = res.confidence;
    } catch (err) {
      if (!(err instanceof JevUnavailableError) || options.fallbackRoute === undefined) throw err;
      choice = options.fallbackRoute;
      degraded = true;
    }

    let resolved = choice;
    if (!routeKeys.includes(resolved)) {
      if (options.fallbackRoute === undefined) {
        throw new InvalidJevAnswerError("createJevRouter", resolved, routeKeys);
      }
      resolved = options.fallbackRoute;
      degraded = true;
    }

    telemetry.record(
      tenantId,
      {
        eventType: "routing_decision",
        latencyMs: Date.now() - t0,
        confidence,
        model: client.modelName,
      },
      {
        choice: resolved,
        routesCount: routeKeys.length,
        degraded,
      }
    );

    options.memory?.increment("routings");
    return resolved;
  };
}
