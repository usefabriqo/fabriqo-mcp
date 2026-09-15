import { safeRequestId } from '../errors/index.js';

export interface TelemetryEvent {
  event:
    | 'mcp_tool_call'
    | 'mcp_authentication'
    | 'mcp_transport_error'
    | 'mcp_startup';
  tool?: string;
  success?: boolean;
  durationMs?: number;
  requestId?: string;
  workspaceId?: number;
  actorUserId?: string;
}
export type TelemetrySink = (event: TelemetryEvent) => void;

/** Allowlisted fields only: never pass errors, headers, args or tokens to logging. */
export function createTelemetry(
  sink: TelemetrySink = (event) => {
    process.stderr.write(`${JSON.stringify(event)}\n`);
  },
): TelemetrySink {
  return (event) => {
    const safe: TelemetryEvent = { event: event.event };
    if (event.tool && /^[a-z][a-z0-9_]{0,63}$/.test(event.tool))
      safe.tool = event.tool;
    if (typeof event.success === 'boolean') safe.success = event.success;
    if (event.durationMs !== undefined && Number.isFinite(event.durationMs))
      safe.durationMs = Math.round(Math.max(0, event.durationMs) * 100) / 100;
    if (safeRequestId(event.requestId)) safe.requestId = event.requestId;
    if (Number.isSafeInteger(event.workspaceId) && (event.workspaceId ?? 0) > 0)
      safe.workspaceId = event.workspaceId;
    if (event.actorUserId && /^[1-9][0-9]{0,18}$/.test(event.actorUserId))
      safe.actorUserId = event.actorUserId;
    try {
      sink(safe);
    } catch {
      /* Telemetry must never fail a tool invocation. */
    }
  };
}
