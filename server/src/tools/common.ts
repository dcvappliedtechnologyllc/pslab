import { PluginError } from "../bridge.js";
import type { DocSummary } from "../protocol.js";

export function toolResult(r: { result: unknown; doc: DocSummary | null }) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ result: r.result, doc: r.doc }) }] };
}

export function toolError(e: unknown) {
  const message = e instanceof PluginError ? `${e.code}: ${e.message}` : String(e);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/** MCP tool annotations, so hosts can warn before destructive calls. Every tool declares all four hints. */
const hint = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint: false, // everything talks to the local Photoshop plugin only
});

export const hints = {
  /** Reads the document or renders a preview; changes nothing. */
  read: hint(true, false, true),
  /** Opens files into Photoshop; repeating it opens nothing new. */
  open: hint(false, false, true),
  /** Adds a layer, mask or selection as one undoable step; repeating it adds another. */
  add: hint(false, false, false),
  /** Sets properties on an existing layer; same args give the same state. */
  set: hint(false, false, true),
  /** Removes or crops document content (confirm-gated, still undoable). */
  destroy: hint(false, true, false),
  /** Writes or overwrites a file on disk (confirm-gated). */
  write: hint(false, true, true),
};
