import { execFile } from "node:child_process";
import { createServer, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createControlHandler } from "./control.js";
import { PluginError, type CallResult, type PluginInfo } from "./errors.js";
import { FollowerClient } from "./follower.js";
import { HelloFrame, parseFrame } from "./protocol.js";

export { PluginError, type CallResult, type PluginInfo } from "./errors.js";

const NOT_CONNECTED_MESSAGE = "Photoshop plugin not connected. Open Plugins > pslab in Photoshop.";
export const DEFAULT_PORT = 9777;
const HELLO_TIMEOUT_MS = 5000;
const PORT_RETRY_MS = 5000;
const HOLDER_LOOKUP_TIMEOUT_MS = 2000;

interface PendingCall {
  resolve: (value: CallResult) => void;
  reject: (err: PluginError) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeOptions {
  port: number;
  timeoutMs: number;
  /** A new socket that has not said hello within this time is closed (default 5000). */
  helloTimeoutMs?: number;
  /** While the port is held by another process, the bind is retried this often (default 5000). */
  portRetryMs?: number;
  /** A follower gives up on a forwarded call after this long (default 65000). */
  followerTimeoutMs?: number;
}

/** owner: holds the port. follower: another pslab server holds it and calls go there. busy: something else holds it. */
export type BridgeMode = "owner" | "follower" | "busy";

/** PSLAB_PORT as a port number: an integer 1024..65535, else the default with a warning. */
export function resolvePort(raw: string | undefined): { port: number; warning?: string } {
  if (raw === undefined || raw === "") return { port: DEFAULT_PORT };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return { port: n };
  return {
    port: DEFAULT_PORT,
    warning: `PSLAB_PORT=${JSON.stringify(raw)} is not a whole number from 1024 to 65535; using ${DEFAULT_PORT}.`,
  };
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: HOLDER_LOOKUP_TIMEOUT_MS }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * Who is listening on the port, as "pid N (node, started by claude)", via
 * lsof and ps; null when nothing is found or the tools are missing. The
 * parent's name tells Claude Desktop ("disclaimer") from Claude Code ("claude").
 */
export async function lookupPortHolder(port: number): Promise<string | null> {
  const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (!out) return null;
  let pid: string | null = null;
  let command: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p") && pid === null) pid = line.slice(1);
    else if (line.startsWith("c") && pid !== null && command === null) command = line.slice(1);
  }
  if (!pid) return null;
  let holder = `pid ${pid}${command ? ` (${command}` : ""}`;
  const ps = await run("ps", ["-o", "ppid=,comm=", "-p", pid]);
  const m = ps?.trim().match(/^(\d+)\s+(.*)$/);
  if (m) {
    const parent = await run("ps", ["-o", "comm=", "-p", m[1]]);
    const parentName = parent?.trim() ? basename(parent.trim()) : null;
    if (parentName) holder += `${command ? ", " : " ("}started by ${parentName} pid ${m[1]}`;
  }
  return holder + (holder.includes("(") ? ")" : "");
}

/** Browser pages send an http(s) Origin; the UXP plugin and local tools do not. */
function originAllowed(origin: string | undefined): boolean {
  if (process.env.PSLAB_DEBUG) console.error(`[bridge] connection origin: ${origin ?? "(none)"}`);
  return !/^https?:/i.test(origin ?? "");
}

/**
 * WebSocket server the Photoshop plugin dials into; correlates requests with
 * responses. The copy that binds the port is the owner and also answers the
 * HTTP control endpoint; a copy that finds another pslab server on the port
 * follows it, forwarding calls there, and takes over when the owner exits.
 */
export class PluginBridge {
  private http: Server | null = null;
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private info: PluginInfo | null = null;
  private follower: FollowerClient | null = null;
  private readonly probes = new Set<ClientRequest>();
  private readonly candidates = new Map<WebSocket, NodeJS.Timeout>();
  private readonly pending = new Map<string, PendingCall>();
  private nextId = 0;
  private portBusy = false;
  private holder: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Bumped by start() and stop(); a retry loop from an earlier generation ends itself. */
  private generation = 0;

  constructor(private readonly opts: BridgeOptions) {}

  get connected(): boolean {
    if (this.follower) return this.follower.connected;
    return this.socket !== null && this.info !== null;
  }

  get pluginInfo(): PluginInfo | null {
    if (this.follower) return this.follower.pluginInfo;
    return this.info;
  }

  get mode(): BridgeMode {
    return this.follower ? "follower" : this.portBusy ? "busy" : "owner";
  }

  /** The pid of the pslab server this one follows; null unless following. */
  get ownerPid(): number | null {
    return this.follower?.ownerPid ?? null;
  }

  /** True while a process that is not pslab holds the port; the bind is being retried. */
  get waitingForPort(): boolean {
    return this.portBusy;
  }

  /** The process holding the port while waiting, e.g. "pid 34130 (node, started by claude pid 34121)"; null when unknown. */
  get portHolder(): string | null {
    return this.portBusy ? this.holder : null;
  }

  /**
   * Binds the port. If another pslab server holds it, resolves anyway (with
   * the requested port) as a follower that forwards calls to it. If something
   * else holds it, every call rejects with PORT_BUSY. Either way the bind is
   * retried in the background until it succeeds. Other bind errors reject.
   */
  async start(): Promise<number> {
    this.stopped = false;
    const gen = ++this.generation;
    try {
      return await this.listen(gen);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      await this.onPortTaken(gen);
      this.scheduleRetry(gen);
      return this.opts.port;
    }
  }

  /** The bind failed with EADDRINUSE: follow the holder if it is pslab, else wait as PORT_BUSY. */
  private async onPortTaken(gen: number): Promise<void> {
    const port = this.opts.port;
    const health = await FollowerClient.probe(port, this.probes);
    if (this.stopped || gen !== this.generation) return;
    if (health) {
      if (this.follower?.ownerPid !== health.pid) {
        this.follower?.stop();
        this.follower = new FollowerClient(port, health, this.opts.followerTimeoutMs);
        if (process.env.PSLAB_DEBUG) console.error(`[bridge] following pslab pid ${health.pid} on 127.0.0.1:${port}`);
      }
      this.portBusy = false;
      this.holder = null;
      return;
    }
    if (this.follower) {
      this.follower.stop();
      this.follower = null;
    }
    // The holder can change (Claude Desktop respawns its server); say so when it does.
    const holder = await lookupPortHolder(port);
    if (this.stopped || gen !== this.generation) return;
    if (this.portBusy && holder && holder !== this.holder) console.error(`[bridge] port ${port} is now held by ${holder}`);
    this.portBusy = true;
    if (holder) this.holder = holder;
  }

  private listen(gen: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const http = createServer(createControlHandler(this));
      http.once("error", (err) => {
        http.close();
        reject(err);
      });
      http.listen(this.opts.port, "127.0.0.1", () => {
        if (gen !== this.generation) {
          // stop() or a newer start() ran while this bind was in flight.
          http.close();
          reject(Object.assign(new Error("stale bind"), { code: "ESTALE" }));
          return;
        }
        http.removeAllListeners("error");
        http.on("error", (err) => console.error("[bridge] server error:", err));
        const server = new WebSocketServer({
          server: http,
          maxPayload: 64 * 1024 * 1024,
          verifyClient: ({ req }: { req: IncomingMessage }) => originAllowed(req.headers.origin),
        });
        server.on("error", (err) => console.error("[bridge] server error:", err));
        server.on("connection", (ws) => this.addCandidate(ws));
        this.http = http;
        this.server = server;
        resolve((http.address() as AddressInfo).port);
      });
    });
  }

  private scheduleRetry(gen: number): void {
    if (this.stopped || gen !== this.generation) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.listen(gen).then(
        (port) => {
          const was = this.mode;
          this.follower?.stop();
          this.follower = null;
          this.portBusy = false;
          this.holder = null;
          const why = was === "follower" ? "the pslab server it followed is gone" : `port ${port} is free again`;
          console.error(`[bridge] ${why}; bridge listening on 127.0.0.1:${port}`);
        },
        async (err) => {
          if (gen !== this.generation) return;
          if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
            await this.onPortTaken(gen);
          } else {
            console.error("[bridge] bind failed:", err instanceof Error ? err.message : err);
          }
          this.scheduleRetry(gen);
        },
      );
    }, this.opts.portRetryMs ?? PORT_RETRY_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const req of this.probes) req.destroy();
    this.probes.clear();
    this.follower?.stop();
    this.follower = null;
    this.portBusy = false;
    this.holder = null;
    this.rejectAllPending();
    this.socket = null;
    this.info = null;
    for (const timer of this.candidates.values()) clearTimeout(timer);
    this.candidates.clear();
    await this.closeServer();
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    const http = this.http;
    this.server = null;
    this.http = null;
    if (server) {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (http) {
      const closed = new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    }
  }

  call(action: string, args: unknown): Promise<CallResult> {
    if (this.follower) return this.follower.call(action, args);
    if (this.portBusy) {
      return Promise.reject(
        new PluginError(
          "PORT_BUSY",
          `Port ${this.opts.port} is held by ${this.holder ?? "another program"}, which is not a current pslab ` +
            "server (an older pslab build, or another app). Quit it, or set PSLAB_PORT.",
        ),
      );
    }
    const socket = this.socket;
    if (!socket || !this.connected || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new PluginError("NOT_CONNECTED", NOT_CONNECTED_MESSAGE));
    }
    const id = `r-${++this.nextId}`;
    return new Promise<CallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError("TIMEOUT", `Photoshop did not answer "${action}" within ${this.opts.timeoutMs} ms.`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "request", id, action, args: args ?? {} }));
    });
  }

  // A new socket is only a candidate: it replaces the connected plugin once it
  // sends a valid pslab hello, and is closed if it stays silent.
  private addCandidate(ws: WebSocket): void {
    const timer = setTimeout(() => {
      if (!this.candidates.delete(ws)) return;
      ws.close(1008, "no hello");
    }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    this.candidates.set(ws, timer);
    ws.on("message", (data) => {
      if (this.candidates.has(ws)) this.handleCandidate(ws, data.toString());
      else if (this.socket === ws) this.handle(ws, data.toString());
    });
    ws.on("close", () => {
      const t = this.candidates.get(ws);
      if (t) clearTimeout(t);
      this.candidates.delete(ws);
      if (this.socket !== ws) return;
      this.rejectAllPending();
      this.socket = null;
      this.info = null;
    });
    ws.on("error", (err) => console.error("[bridge] socket error:", err.message));
  }

  private handleCandidate(ws: WebSocket, text: string): void {
    let hello;
    try {
      hello = HelloFrame.safeParse(JSON.parse(text));
    } catch {
      return;
    }
    if (!hello.success) return;
    clearTimeout(this.candidates.get(ws));
    this.candidates.delete(ws);
    const old = this.socket;
    if (old) {
      this.rejectAllPending();
      old.close();
    }
    this.socket = ws;
    this.info = { version: hello.data.version, ps: hello.data.ps };
  }

  private handle(ws: WebSocket, text: string): void {
    let frame;
    try {
      frame = parseFrame(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[bridge] ignoring invalid frame:", message);
      this.rejectMalformedResponse(text, message);
      return;
    }
    switch (frame.type) {
      case "hello":
        this.info = { version: frame.version, ps: frame.ps };
        return;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      case "response": {
        const call = this.pending.get(frame.id);
        if (!call) return;
        this.pending.delete(frame.id);
        clearTimeout(call.timer);
        if (frame.ok) call.resolve({ result: frame.result, doc: frame.doc });
        else call.reject(new PluginError(frame.error.code, frame.error.message));
        return;
      }
      default:
        return;
    }
  }

  // A response for a pending call that fails the schema rejects that call
  // instead of leaving it to time out.
  private rejectMalformedResponse(text: string, message: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const { type, id } = raw as { type?: unknown; id?: unknown };
    if (type !== "response" || typeof id !== "string") return;
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    call.reject(new PluginError("PROTOCOL", `Photoshop sent a malformed response: ${message}`));
  }

  private rejectAllPending(): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new PluginError("NOT_CONNECTED", NOT_CONNECTED_MESSAGE));
    }
    this.pending.clear();
  }
}
