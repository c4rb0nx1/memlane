// Lightweight in-process telemetry. Held in memory; no persistence.
// Reset on each server start.

export interface ToolStats {
  calls: number;
  errors: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastCallAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export interface TelemetrySnapshot {
  startedAt: string;
  uptimeSec: number;
  totalCalls: number;
  totalErrors: number;
  perTool: Record<string, ToolStats>;
}

export interface TelemetryHooks {
  onRead?: (event: { tool: string; latencyMs: number }) => void;
  onWrite?: (event: { tool: string; latencyMs: number }) => void;
  onError?: (event: { tool: string; error: Error }) => void;
}

const READ_TOOLS = new Set([
  "read_graph",
  "search_nodes",
  "recent_activity",
  "open_nodes",
  "get_state",
  "bootstrap",
  "neighbors",
  "list_workstreams",
  "check_vocabulary",
  "health",
]);

export class Telemetry {
  private startedAt = new Date();
  private perTool = new Map<string, ToolStats>();
  private hooks: TelemetryHooks;

  constructor(hooks: TelemetryHooks = {}) {
    this.hooks = hooks;
  }

  private getOrCreate(tool: string): ToolStats {
    let s = this.perTool.get(tool);
    if (!s) {
      s = {
        calls: 0,
        errors: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
        lastCallAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
      };
      this.perTool.set(tool, s);
    }
    return s;
  }

  recordSuccess(tool: string, latencyMs: number): void {
    const s = this.getOrCreate(tool);
    s.calls += 1;
    s.totalLatencyMs += latencyMs;
    if (latencyMs > s.maxLatencyMs) s.maxLatencyMs = latencyMs;
    s.lastCallAt = new Date().toISOString();
    if (READ_TOOLS.has(tool)) this.hooks.onRead?.({ tool, latencyMs });
    else this.hooks.onWrite?.({ tool, latencyMs });
  }

  recordError(tool: string, err: Error): void {
    const s = this.getOrCreate(tool);
    s.calls += 1;
    s.errors += 1;
    s.lastCallAt = new Date().toISOString();
    s.lastErrorAt = s.lastCallAt;
    s.lastErrorMessage = err.message;
    this.hooks.onError?.({ tool, error: err });
  }

  snapshot(): TelemetrySnapshot {
    const perTool: Record<string, ToolStats> = {};
    let totalCalls = 0;
    let totalErrors = 0;
    for (const [name, s] of this.perTool.entries()) {
      perTool[name] = { ...s };
      totalCalls += s.calls;
      totalErrors += s.errors;
    }
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      totalCalls,
      totalErrors,
      perTool,
    };
  }
}

// Exported helper: wrap an MCP tool handler with telemetry. Returns a new
// handler that records timing on success and error message on throw, then
// rethrows so MCP server still surfaces the error to the caller.
export function instrument<TArgs>(
  telemetry: Telemetry,
  toolName: string,
  handler: (args: TArgs) => Promise<unknown>
): (args: TArgs) => Promise<unknown> {
  return async (args) => {
    const t0 = Date.now();
    try {
      const result = await handler(args);
      telemetry.recordSuccess(toolName, Date.now() - t0);
      return result;
    } catch (err) {
      telemetry.recordError(toolName, err as Error);
      throw err;
    }
  };
}
