import type { DocSummary } from "./protocol.js";

export class PluginError extends Error {
  constructor(
    readonly code: "NOT_CONNECTED" | "TIMEOUT" | "PROTOCOL" | "PORT_BUSY" | string,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export interface CallResult {
  result: unknown;
  doc: DocSummary | null;
}

export interface PluginInfo {
  version: string;
  ps: string;
}
