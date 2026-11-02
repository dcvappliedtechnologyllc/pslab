import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallResult, PluginInfo } from "./errors.js";

/** Largest POST /pslab/call body the owner accepts. */
export const CONTROL_BODY_LIMIT = 1024 * 1024;

/** What the control endpoint needs from the owning bridge. */
export interface ControlTarget {
  readonly connected: boolean;
  readonly pluginInfo: PluginInfo | null;
  call(action: string, args: unknown): Promise<CallResult>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Only local, non-browser callers: the Host must be loopback (blocks DNS
 * rebinding) and there must be no http(s) Origin (blocks web pages).
 */
function localCaller(req: IncomingMessage): boolean {
  if (/^https?:/i.test(req.headers.origin ?? "")) return false;
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/** The body as text, or null when it is over the limit. Settles once, even if the client hangs up. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > CONTROL_BODY_LIMIT) {
        chunks.length = 0;
        settle(() => resolve(null));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (err) => settle(() => reject(err)));
    req.on("close", () => settle(() => reject(new Error("client closed the request before the body ended"))));
  });
}

/**
 * Plain-HTTP side of the owner's port, for pslab servers that lost the bind:
 *   GET  /pslab/health -> {pslab, pid, connected, plugin}
 *   POST /pslab/call   -> {ok:true, result, doc} | {ok:false, code, message}
 * The call needs `x-pslab: 1` and a JSON content type, so a browser would have
 * to preflight it, and preflights are never answered.
 */
export function createControlHandler(target: ControlTarget): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(target, req, res).catch((err) => {
      console.error("[control] request failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) send(res, 500, { ok: false, code: "INTERNAL", message: "pslab control request failed" });
      else res.destroy();
    });
  };
}

async function handle(target: ControlTarget, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (path !== "/pslab/health" && path !== "/pslab/call") return send(res, 404, { error: "not found" });
  if (!localCaller(req)) return send(res, 403, { error: "forbidden" });

  if (path === "/pslab/health") {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
    return send(res, 200, { pslab: true, pid: process.pid, connected: target.connected, plugin: target.pluginInfo });
  }

  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (req.headers["x-pslab"] !== "1" || contentType !== "application/json") {
    return send(res, 403, { error: "forbidden" });
  }
  if (Number(req.headers["content-length"] ?? 0) > CONTROL_BODY_LIMIT) {
    req.resume();
    return send(res, 413, { error: "body over 1 MB" });
  }
  const text = await readBody(req);
  if (text === null) {
    res.setHeader("connection", "close");
    return send(res, 413, { error: "body over 1 MB" });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return send(res, 400, { error: "body is not JSON" });
  }
  const { action, args } = (body ?? {}) as { action?: unknown; args?: unknown };
  if (typeof action !== "string") return send(res, 400, { error: "action must be a string" });
  if (process.env.PSLAB_DEBUG) console.error(`[control] forwarded call: ${action}`);
  try {
    const { result, doc } = await target.call(action, args);
    send(res, 200, { ok: true, result, doc });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    send(res, 200, {
      ok: false,
      code: typeof e.code === "string" ? e.code : "INTERNAL",
      message: typeof e.message === "string" ? e.message : String(err),
    });
  }
}
