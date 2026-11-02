import WebSocket from "ws";
import { parseFrame, type DocSummary } from "../src/protocol.js";

export type FakeReply =
  | { ok: true; result: unknown; doc: DocSummary | null }
  | { ok: false; error: { code: string; message: string } };

export type FakeHandler = (action: string, args: unknown) => Promise<FakeReply>;

/** Stands in for the Photoshop UXP plugin: dials the bridge, says hello, answers requests. */
export class FakePlugin {
  private ws: WebSocket | null = null;
  private handler: FakeHandler = async () => ({ ok: true, result: null, doc: null });
  private pongWaiters: Array<() => void> = [];
  private closedResolve!: () => void;
  readonly closed: Promise<void> = new Promise((resolve) => (this.closedResolve = resolve));

  constructor(private readonly port: number) {}

  /** Close code the bridge sent, once the socket has closed. */
  closeCode: number | null = null;

  /** Opens the socket without saying hello. */
  async open(options: WebSocket.ClientOptions = {}): Promise<void> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}`, options);
    this.ws = ws;
    ws.on("close", (code) => {
      this.closeCode = code;
      this.closedResolve();
    });
    ws.on("message", (data) => void this.handle(data.toString()));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
  }

  /** Opens the socket, sends hello, and resolves once the bridge has processed it (ping/pong round trip). */
  async connect(): Promise<void> {
    await this.open();
    this.ws!.send(JSON.stringify({ type: "hello", plugin: "pslab", version: "0.1.0", ps: "27.11.0" }));
    await this.ping();
  }

  onRequest(handler: FakeHandler): void {
    this.handler = handler;
  }

  /** Sends a ping and resolves when the matching pong arrives. */
  ping(): Promise<void> {
    return new Promise((resolve) => {
      this.pongWaiters.push(resolve);
      this.ws?.send(JSON.stringify({ type: "ping" }));
    });
  }

  /** Sends arbitrary text, for exercising the bridge's handling of bad frames. */
  sendRaw(text: string): void {
    this.ws?.send(text);
  }

  close(): void {
    this.ws?.close();
  }

  private async handle(text: string): Promise<void> {
    const frame = parseFrame(text);
    if (frame.type === "pong") {
      this.pongWaiters.shift()?.();
      return;
    }
    if (frame.type !== "request") return;
    const reply = await this.handler(frame.action, frame.args);
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "response", id: frame.id, ...reply }));
  }
}
