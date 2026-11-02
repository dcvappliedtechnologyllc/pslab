import { request, type ClientRequest } from "node:http";
import { PluginError, type CallResult, type PluginInfo } from "./errors.js";

/** Longer than the owner's own 60 s call timeout, so the owner's TIMEOUT wins. */
export const FOLLOWER_CALL_TIMEOUT_MS = 65000;
const PROBE_TIMEOUT_MS = 1000;
const PROBE_MIN_INTERVAL_MS = 1000;

export interface OwnerHealth {
  pid: number;
  connected: boolean;
  plugin: PluginInfo | null;
}

interface HttpReply {
  status: number;
  body: string;
}

/** One HTTP request to the owner on 127.0.0.1, without keep-alive. */
function httpRequest(
  port: number,
  method: "GET" | "POST",
  path: string,
  body: string | null,
  timeoutMs: number,
  track: Set<ClientRequest>,
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
      headers["x-pslab"] = "1";
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false });
    track.add(req);
    const done = () => track.delete(req);
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (err) => {
      done();
      reject(err);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        done();
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => {
        done();
        reject(err);
      });
    });
    req.end(body ?? undefined);
  });
}

function parseHealth(reply: HttpReply): OwnerHealth | null {
  if (reply.status !== 200) return null;
  try {
    const h = JSON.parse(reply.body) as Record<string, unknown>;
    if (h.pslab !== true || typeof h.pid !== "number") return null;
    const p = h.plugin as Record<string, unknown> | null;
    const plugin = p && typeof p.version === "string" && typeof p.ps === "string" ? { version: p.version, ps: p.ps } : null;
    return { pid: h.pid, connected: h.connected === true, plugin };
  } catch {
    return null;
  }
}

/**
 * Talks to the pslab server that owns the port: health probes for the
 * connection state and POST /pslab/call for tool calls.
 */
export class FollowerClient {
  private last: OwnerHealth;
  private probedAt = Date.now();
  private probing: Promise<void> | null = null;
  private readonly inflight = new Set<ClientRequest>();
  private stopped = false;

  constructor(
    readonly port: number,
    health: OwnerHealth,
    private readonly callTimeoutMs = FOLLOWER_CALL_TIMEOUT_MS,
  ) {
    this.last = health;
  }

  /** GET /pslab/health; null when the holder does not answer as pslab. */
  static async probe(port: number, track = new Set<ClientRequest>()): Promise<OwnerHealth | null> {
    try {
      return parseHealth(await httpRequest(port, "GET", "/pslab/health", null, PROBE_TIMEOUT_MS, track));
    } catch {
      return null;
    }
  }

  get ownerPid(): number {
    return this.last.pid;
  }

  get connected(): boolean {
    this.refresh();
    return this.last.connected;
  }

  get pluginInfo(): PluginInfo | null {
    this.refresh();
    return this.last.plugin;
  }

  /** Re-probes in the background, at most once a second; the getters return the cached answer. */
  private refresh(): void {
    if (this.stopped || this.probing || Date.now() - this.probedAt < PROBE_MIN_INTERVAL_MS) return;
    this.probedAt = Date.now();
    this.probing = FollowerClient.probe(this.port, this.inflight).then((h) => {
      this.probing = null;
      if (this.stopped) return;
      this.last = h ?? { ...this.last, connected: false, plugin: null };
    });
  }

  async call(action: string, args: unknown): Promise<CallResult> {
    if (this.stopped) throw new PluginError("NOT_CONNECTED", "pslab server is shutting down.");
    let reply: HttpReply;
    try {
      reply = await httpRequest(
        this.port,
        "POST",
        "/pslab/call",
        JSON.stringify({ action, args: args ?? {} }),
        this.callTimeoutMs,
        this.inflight,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") {
        throw new PluginError("TIMEOUT", `The pslab server on port ${this.port} did not answer "${action}" within ${this.callTimeoutMs} ms.`);
      }
      if (code === "ECONNREFUSED") {
        throw new PluginError(
          "NOT_CONNECTED",
          `The pslab server that owned port ${this.port} (pid ${this.last.pid}) is gone, so "${action}" was not sent; this one takes over within about 5 s. Try again then.`,
        );
      }
      throw new PluginError(
        "NOT_CONNECTED",
        `The pslab server that owns port ${this.port} (pid ${this.last.pid}) went away; the edit may or may not have been applied, so check get_document before retrying.`,
      );
    }
    let body: { ok?: unknown; result?: unknown; doc?: unknown; code?: unknown; message?: unknown };
    try {
      body = JSON.parse(reply.body);
    } catch {
      body = {};
    }
    if (reply.status !== 200 || typeof body.ok !== "boolean") {
      throw new PluginError("PROTOCOL", `The pslab server on port ${this.port} answered HTTP ${reply.status}.`);
    }
    if (!body.ok) {
      throw new PluginError(typeof body.code === "string" ? body.code : "PROTOCOL", String(body.message ?? ""));
    }
    return { result: body.result, doc: (body.doc ?? null) as CallResult["doc"] };
  }

  /** Aborts probes and forwarded calls in flight. */
  stop(): void {
    this.stopped = true;
    for (const req of this.inflight) req.destroy();
    this.inflight.clear();
  }
}
