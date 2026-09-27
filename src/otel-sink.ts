/**
 * Dependency-free OTLP/JSON telemetry sink (SS-SC-58/59).
 *
 * Wire it as a `TelemetryCollector`'s `sink` and it turns each flushed batch into an
 * OTLP/JSON `ExportLogsServiceRequest` body (proto3 JSON mapping - int64 fields are decimal
 * strings) and hands the serialized request to an injected transport. Without an injected
 * transport, an OTLP/HTTP endpoint `url` gets a plain `fetch` POST that fails closed on non-2xx.
 *
 * Scrubbing is re-applied at the export boundary: every string crossing the wire passes the shared
 * bounded pattern set again (the markers are idempotent), so the wire cannot leak even if an event
 * was built outside `TelemetryCollector.record`. Nothing is ever persisted to disk here - and a
 * `zeroRetention` exporter refuses to serialize or send at all, matching the collector's
 * "evaluate in RAM, no disk storage" toggle end-to-end.
 */
import { scrubSecrets } from "./telemetry.js";
import type { TelemetryEvent } from "./telemetry.js";

/** proto3 JSON `AnyValue`. */
export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  /** int64 - decimal string per the proto3 JSON mapping. */
  intValue?: string;
  doubleValue?: number;
  arrayValue?: { values: OtlpAnyValue[] };
  kvlistValue?: { values: OtlpKeyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  /** Nanoseconds since the epoch as a decimal string (int64 per the proto3 JSON mapping). */
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  name: string;
  body: OtlpAnyValue;
  attributes: OtlpKeyValue[];
}

export interface OtlpLogsPayload {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{ scope: { name: string }; logRecords: OtlpLogRecord[] }>;
  }>;
}

/** The fully serialized request handed to the transport. */
export interface OtlpTransportRequest {
  /** OTLP/HTTP logs endpoint; empty when the exporter was built with an injected transport only. */
  url: string;
  headers: Record<string, string>;
  /** Serialized OTLP/JSON `ExportLogsServiceRequest`. */
  body: string;
}

export type OtlpTransport = (request: OtlpTransportRequest) => Promise<void> | void;

export interface OtelExporterOptions {
  /** OTLP/HTTP logs endpoint (e.g. `https://collector:4318/v1/logs`). Required unless `transport` is injected or `zeroRetention` is on. */
  url?: string;
  /** Extra request headers, merged over the OTLP/JSON content type. */
  headers?: Record<string, string>;
  /** Injected sender; receives the fully serialized request. Transport failures propagate (the collector requeues the batch). */
  transport?: OtlpTransport;
  /** Value of the `service.name` resource attribute (default `swarm-sentinel`). */
  serviceName?: string;
  /** Enterprise no-retention mode: nothing is serialized, sent, or persisted when true. */
  zeroRetention?: boolean;
}

export interface OtlpExportResult {
  /** Log records handed to the transport; 0 when nothing was exported. */
  exported: number;
  /** The payload that was sent; null when nothing was exported. */
  payload: OtlpLogsPayload | null;
}

/** Log severity per event class: deaths are ERROR, safety/health events WARN, routine flow INFO. */
const SEVERITY_BY_EVENT: Record<TelemetryEvent["eventType"], { severityNumber: number; severityText: string }> = {
  routing_decision: { severityNumber: 9, severityText: "INFO" },
  worker_death: { severityNumber: 17, severityText: "ERROR" },
  recovery_dispatch: { severityNumber: 9, severityText: "INFO" },
  oversight_quarantine: { severityNumber: 13, severityText: "WARN" },
  shield_block: { severityNumber: 13, severityText: "WARN" },
  shield_escalation: { severityNumber: 13, severityText: "WARN" },
  dispatch_degraded: { severityNumber: 13, severityText: "WARN" },
  completion_gate: { severityNumber: 9, severityText: "INFO" },
};

const SCRUB_DEPTH_LIMIT = 6;
const ARRAY_ITEM_LIMIT = 100;

/**
 * Converts one telemetry value to the proto3 JSON `AnyValue` shape, scrubbing every string with
 * the shared bounded pattern set on the way out. Mirrors the collector's recursion bounds
 * (`[SCRUB_DEPTH_LIMIT]`, 100-item arrays); `undefined` and non-serializable values are dropped.
 */
function toAnyValue(value: unknown, depth: number): OtlpAnyValue | null {
  if (value === undefined) return null;
  if (value === null) return { stringValue: "null" };
  if (typeof value === "string") return { stringValue: scrubSecrets(value) };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "bigint") return { stringValue: String(value) };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { stringValue: String(value) };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value !== "object") return null;
  if (depth >= SCRUB_DEPTH_LIMIT) return { stringValue: "[SCRUB_DEPTH_LIMIT]" };
  if (Array.isArray(value)) {
    const values: OtlpAnyValue[] = [];
    for (const item of value.slice(0, ARRAY_ITEM_LIMIT)) {
      const converted = toAnyValue(item, depth + 1);
      if (converted !== null) values.push(converted);
    }
    return { arrayValue: { values } };
  }
  const entries: OtlpKeyValue[] = [];
  for (const [key, item] of Object.entries(value)) {
    const converted = toAnyValue(item, depth + 1);
    if (converted !== null) entries.push({ key, value: converted });
  }
  return { kvlistValue: { values: entries } };
}

/** Builds the OTLP/JSON log record for one telemetry event. */
function toLogRecord(event: TelemetryEvent): OtlpLogRecord {
  const timestampMs = Number.isFinite(event.timestamp) ? Math.trunc(event.timestamp) : 0;
  const timeUnixNano = String(BigInt(timestampMs) * 1_000_000n);
  const severity = SEVERITY_BY_EVENT[event.eventType];
  const latencyMs = Number.isFinite(event.latencyMs) ? Math.trunc(event.latencyMs) : 0;
  const confidence = Number.isFinite(event.confidence) ? event.confidence : 0;
  const attributes: OtlpKeyValue[] = [
    { key: "tenant.hash", value: { stringValue: scrubSecrets(event.tenantHash) } },
    { key: "latency.ms", value: { intValue: String(latencyMs) } },
    { key: "confidence", value: { doubleValue: confidence } },
    { key: "model", value: { stringValue: scrubSecrets(event.model) } },
    { key: "byok", value: { boolValue: event.byok } },
  ];
  for (const [key, value] of Object.entries(event.sanitizedMetadata)) {
    const converted = toAnyValue(value, 0);
    if (converted !== null) attributes.push({ key: `metadata.${key}`, value: converted });
  }
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: severity.severityNumber,
    severityText: severity.severityText,
    name: event.eventType,
    body: { stringValue: `swarm_sentinel.${event.eventType}` },
    attributes,
  };
}

/**
 * Builds the OTLP/JSON `ExportLogsServiceRequest` payload for a batch of telemetry events.
 * Pure: no I/O, no persistence - the only sink of secrets is `scrubSecrets`.
 */
export function buildOtlpLogsPayload(
  events: TelemetryEvent[],
  options: { serviceName?: string } = {}
): OtlpLogsPayload {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: scrubSecrets(options.serviceName ?? "swarm-sentinel") } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "swarm-sentinel.otel-sink" },
            logRecords: events.map((event) => toLogRecord(event)),
          },
        ],
      },
    ],
  };
}

/** The stock OTLP/HTTP sender: plain `fetch`, failing closed on a non-2xx collector response. */
const httpTransport: OtlpTransport = async (request) => {
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) throw new Error(`OTLP/HTTP export failed with status ${response.status}`);
};

/**
 * OpenTelemetry exporter over the scrubbed telemetry buffer.
 * Wire it as the collector's `sink`: `(events) => exporter.export(events)`.
 */
export class OtelExporter {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly transport: OtlpTransport | null;
  private readonly serviceName: string;
  private readonly zeroRetention: boolean;

  constructor(options: OtelExporterOptions = {}) {
    this.url = options.url ?? "";
    this.headers = { "content-type": "application/json", ...options.headers };
    this.serviceName = options.serviceName ?? "swarm-sentinel";
    this.zeroRetention = options.zeroRetention ?? false;
    this.transport = options.transport ?? (options.url ? httpTransport : null);
    if (this.transport === null && !this.zeroRetention) {
      throw new Error("OtelExporter needs an OTLP endpoint url or an injected transport (unless zeroRetention is on)");
    }
  }

  /**
   * Serializes a batch to OTLP/JSON and hands it to the transport.
   * Under `zeroRetention` (or an empty batch) nothing is serialized or sent. Transport failures
   * propagate so `TelemetryCollector.flush()` can requeue the batch.
   */
  public async export(events: TelemetryEvent[]): Promise<OtlpExportResult> {
    if (this.zeroRetention || this.transport === null || events.length === 0) {
      return { exported: 0, payload: null };
    }
    const payload = buildOtlpLogsPayload(events, { serviceName: this.serviceName });
    await this.transport({ url: this.url, headers: this.headers, body: JSON.stringify(payload) });
    return { exported: payload.resourceLogs[0].scopeLogs[0].logRecords.length, payload };
  }
}
