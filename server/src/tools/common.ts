import { PluginError } from "../bridge.js";
import type { DocSummary } from "../protocol.js";

export function toolResult(r: { result: unknown; doc: DocSummary | null }) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ result: r.result, doc: r.doc }) }] };
}

export function toolError(e: unknown) {
  const message = e instanceof PluginError ? `${e.code}: ${e.message}` : String(e);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
