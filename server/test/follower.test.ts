import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginBridge, PluginError } from "../src/bridge.js";
import type { DocSummary } from "../src/protocol.js";
import { FakePlugin } from "./fake-plugin.js";

const NOT_CONNECTED_MSG = "Photoshop plugin not connected. Open Plugins > pslab in Photoshop.";
const DOC: DocSummary = {
  id: 7,
  name: "a.psd",
  width: 10,
  height: 20,
  ppi: 72,
  profile: "sRGB IEC61966-2.1",
  bits: 8,
  activeLayerId: 1,
  layers: [],
};

let bridges: PluginBridge[] = [];
let fakes: FakePlugin[] = [];
let netServers: Server[] = [];

afterEach(async () => {
  for (const f of fakes) f.close();
  fakes = [];
  for (const b of bridges) await b.stop();
  bridges = [];
  for (const s of netServers) await new Promise<void>((r) => s.close(() => r()));
  netServers = [];
});

function newBridge(port: number, portRetryMs = 5000, more: { timeoutMs?: number; followerTimeoutMs?: number } = {}): PluginBridge {
  const b = new PluginBridge({ port, timeoutMs: 2000, portRetryMs, ...more });
  bridges.push(b);
  return b;
}

async function owner(timeoutMs = 2000): Promise<{ bridge: PluginBridge; port: number }> {
  const bridge = newBridge(0, 5000, { timeoutMs });
  const port = await bridge.start();
  return { bridge, port };
}

async function connectFake(port: number): Promise<FakePlugin> {
  const fake = new FakePlugin(port);
  fakes.push(fake);
  await fake.connect();
  return fake;
}

function postCall(port: number, body: unknown, headers: Record<string, string> = { "x-pslab": "1", "content-type": "application/json" }) {
  return fetch(`http://127.0.0.1:${port}/pslab/call`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** A raw request, for headers fetch will not let a caller set (Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("control endpoint", () => {
  it("health endpoint answers", async () => {
    const { port } = await owner();
    const res = await fetch(`http://127.0.0.1:${port}/pslab/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pslab: true, pid: process.pid, connected: false, plugin: null });
    await connectFake(port);
    const again = await fetch(`http://127.0.0.1:${port}/pslab/health`);
    expect(await again.json()).toEqual({ pslab: true, pid: process.pid, connected: true, plugin: { version: "0.1.0", ps: "27.11.0" } });
  });

  it("call endpoint forwards to the plugin and returns result and doc", async () => {
    const { port } = await owner();
    const fake = await connectFake(port);
    const seen: Array<[string, unknown]> = [];
    fake.onRequest(async (action, args) => {
      seen.push([action, args]);
      return { ok: true, result: { layers: 3 }, doc: DOC };
    });
    const res = await postCall(port, { action: "get_document", args: { doc: 7 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { layers: 3 }, doc: DOC });
    expect(seen).toEqual([["get_document", { doc: 7 }]]);

    fake.onRequest(async () => ({ ok: false, error: { code: "NO_DOCUMENT", message: "No document is open." } }));
    const bad = await postCall(port, { action: "get_document", args: {} });
    expect(await bad.json()).toEqual({ ok: false, code: "NO_DOCUMENT", message: "No document is open." });
  });

  it("call endpoint rejects without the x-pslab header (403)", async () => {
    const { port } = await owner();
    const fake = await connectFake(port);
    let calls = 0;
    fake.onRequest(async () => {
      calls++;
      return { ok: true, result: null, doc: null };
    });
    const body = { action: "get_document", args: {} };
    expect((await postCall(port, body, { "content-type": "application/json" })).status).toBe(403);
    expect((await postCall(port, body, { "x-pslab": "1", "content-type": "text/plain" })).status).toBe(403);
    expect((await postCall(port, body, { "x-pslab": "1", "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("call endpoint answers 413 for a body over 1 MB and 400 for a body that is not JSON", async () => {
    const { port } = await owner();
    const big = await postCall(port, { action: "x", args: { pad: "a".repeat(1024 * 1024) } });
    expect(big.status).toBe(413);
    const notJson = await fetch(`http://127.0.0.1:${port}/pslab/call`, {
      method: "POST",
      headers: { "x-pslab": "1", "content-type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
  });

  it("a browser preflight gets no CORS approval", async () => {
    const { port } = await owner();
    const res = await raw(port, "OPTIONS", "/pslab/call", {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "x-pslab, content-type",
    });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a non-loopback Host is refused (403)", async () => {
    const { port } = await owner();
    expect((await raw(port, "GET", "/pslab/health", { host: `evil.example:${port}` })).status).toBe(403);
    expect((await raw(port, "POST", "/pslab/call", { host: "evil.example", "x-pslab": "1", "content-type": "application/json" })).status).toBe(403);
    expect((await raw(port, "GET", "/pslab/health", { host: `localhost:${port}` })).status).toBe(200);
  });
});

describe("follower mode", () => {
  it("second bridge on the same port becomes a follower and its call() reaches the plugin through the owner", async () => {
    const { bridge: first, port } = await owner();
    const fake = await connectFake(port);
    fake.onRequest(async (action, args) => ({ ok: true, result: { action, args }, doc: DOC }));
    const second = newBridge(port);
    await expect(second.start()).resolves.toBe(port);
    expect(second.mode).toBe("follower");
    expect(second.ownerPid).toBe(process.pid);
    expect(second.waitingForPort).toBe(false);
    expect(second.connected).toBe(true);
    expect(second.pluginInfo).toEqual({ version: "0.1.0", ps: "27.11.0" });
    await expect(second.call("render_preview", { size: 512 })).resolves.toEqual({
      result: { action: "render_preview", args: { size: 512 } },
      doc: DOC,
    });
    expect(first.mode).toBe("owner");
  });

  it("follower surfaces the owner's PluginError code", async () => {
    const { port } = await owner();
    const second = newBridge(port);
    await second.start();
    expect(second.mode).toBe("follower");
    expect(second.connected).toBe(false);
    const err = await second.call("get_document", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("NOT_CONNECTED");
    expect(err.message).toBe(NOT_CONNECTED_MSG);
  });

  it("follower gives up with TIMEOUT after followerTimeoutMs", async () => {
    const { port } = await owner(5000);
    const fake = await connectFake(port);
    fake.onRequest(() => new Promise(() => {}));
    const second = newBridge(port, 5000, { followerTimeoutMs: 200 });
    await second.start();
    expect(second.mode).toBe("follower");
    const started = Date.now();
    const err = await second.call("slow", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("owner stopping mid-call rejects the follower's call with NOT_CONNECTED promptly", async () => {
    const { bridge: first, port } = await owner(5000);
    const fake = await connectFake(port);
    fake.onRequest(() => new Promise(() => {}));
    const second = newBridge(port);
    await second.start();
    const pending = second.call("hang", {}).catch((e) => e);
    await expect.poll(() => (first as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
    const started = Date.now();
    await first.stop();
    const err = await pending;
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("NOT_CONNECTED");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("follower becomes owner after the owner stops", async () => {
    const { bridge: first, port } = await owner();
    const second = newBridge(port, 30);
    await second.start();
    expect(second.mode).toBe("follower");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await first.stop();
      await expect.poll(() => second.mode, { timeout: 2000 }).toBe("owner");
      expect(logged.mock.calls.flat().join(" ")).toContain(`bridge listening on 127.0.0.1:${port}`);
    } finally {
      logged.mockRestore();
    }
    expect(second.ownerPid).toBeNull();
    await expect(second.call("get_document", {})).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    const fake = await connectFake(port);
    fake.onRequest(async () => ({ ok: true, result: "from-new-owner", doc: null }));
    expect(second.connected).toBe(true);
    await expect(second.call("x", {})).resolves.toEqual({ result: "from-new-owner", doc: null });
    const health = await fetch(`http://127.0.0.1:${port}/pslab/health`);
    expect(await health.json()).toMatchObject({ pslab: true, connected: true });
  });

  it("non-pslab holder still yields PORT_BUSY", async () => {
    const holder = createServer((s) => s.destroy());
    netServers.push(holder);
    await new Promise<void>((r) => holder.listen(0, "127.0.0.1", () => r()));
    const port = (holder.address() as { port: number }).port;
    const bridge = newBridge(port);
    await expect(bridge.start()).resolves.toBe(port);
    expect(bridge.mode).toBe("busy");
    expect(bridge.waitingForPort).toBe(true);
    const err = await bridge.call("get_document", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("PORT_BUSY");
    expect(err.message).toMatch(
      new RegExp(
        `^Port ${port} is held by pid ${process.pid} \\(node.*\\), which is not a current pslab server \\(an older pslab build, or another app\\)\\. Quit it, or set PSLAB_PORT\\.$`,
      ),
    );
  });
});
