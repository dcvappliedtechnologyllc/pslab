import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { PluginBridge, PluginError, resolvePort } from "../src/bridge.js";
import type { DocSummary } from "../src/protocol.js";
import { FakePlugin } from "./fake-plugin.js";

const NOT_CONNECTED_MSG = "Photoshop plugin not connected. Open Plugins > pslab in Photoshop.";

let bridge: PluginBridge | null = null;
let extraBridges: PluginBridge[] = [];
let fakes: FakePlugin[] = [];
let holders: ChildProcess[] = [];

/** Another pslab-like server in its own process, the way Claude Desktop or another session holds the port. */
async function holdPortInAnotherProcess(port: number): Promise<ChildProcess> {
  const src = `const {WebSocketServer}=require('ws');new WebSocketServer({host:'127.0.0.1',port:${port}}).on('listening',()=>console.log('held'));`;
  const child = spawn(process.execPath, ["-e", src], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  holders.push(child);
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  return child;
}

/** A free loopback port, released again before the test binds it. */
async function freePort(): Promise<number> {
  const probe = new PluginBridge({ port: 0, timeoutMs: 1000 });
  const port = await probe.start();
  await probe.stop();
  return port;
}

async function setup(timeoutMs = 2000, helloTimeoutMs = 5000): Promise<{ bridge: PluginBridge; port: number }> {
  bridge = new PluginBridge({ port: 0, timeoutMs, helloTimeoutMs });
  const port = await bridge.start();
  return { bridge, port };
}

async function connectFake(port: number): Promise<FakePlugin> {
  const fake = new FakePlugin(port);
  fakes.push(fake);
  await fake.connect();
  return fake;
}

afterEach(async () => {
  for (const f of fakes) f.close();
  fakes = [];
  for (const h of holders) h.kill("SIGKILL");
  holders = [];
  for (const b of extraBridges) await b.stop();
  extraBridges = [];
  await bridge?.stop();
  bridge = null;
});

describe("PluginBridge", () => {
  it("rejects immediately when no plugin", async () => {
    const { bridge } = await setup();
    const started = Date.now();
    const err = await bridge.call("get_document", {}).catch((e) => e);
    expect(Date.now() - started).toBeLessThan(100);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("NOT_CONNECTED");
    expect(err.message).toBe(NOT_CONNECTED_MSG);
    expect(bridge.connected).toBe(false);
  });

  it("records plugin info from hello", async () => {
    const { bridge, port } = await setup();
    await connectFake(port);
    expect(bridge.connected).toBe(true);
    expect(bridge.pluginInfo).toEqual({ version: "0.1.0", ps: "27.11.0" });
  });

  it("correlates concurrent calls", async () => {
    const { bridge, port } = await setup();
    const fake = await connectFake(port);
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    fake.onRequest(async (action) => {
      if (action === "first") await firstHeld;
      return { ok: true, result: { answeredFor: action }, doc: null };
    });
    const first = bridge.call("first", {});
    const second = bridge.call("second", {});
    await expect(second).resolves.toEqual({ result: { answeredFor: "second" }, doc: null });
    releaseFirst();
    await expect(first).resolves.toEqual({ result: { answeredFor: "first" }, doc: null });
  });

  it("times out", async () => {
    const { bridge, port } = await setup(50);
    const fake = await connectFake(port);
    fake.onRequest(() => new Promise(() => {}));
    const err = await bridge.call("slow", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("TIMEOUT");
  });

  it("surfaces plugin error", async () => {
    const { bridge, port } = await setup();
    const fake = await connectFake(port);
    fake.onRequest(async () => ({ ok: false, error: { code: "NO_DOCUMENT", message: "No document is open." } }));
    const err = await bridge.call("get_document", {}).catch((e) => e);
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("NO_DOCUMENT");
    expect(err.message).toBe("No document is open.");
  });

  it("reconnect replaces connection", async () => {
    const { bridge, port } = await setup();
    const oldFake = await connectFake(port);
    oldFake.onRequest(() => new Promise(() => {}));
    const pendingOnOld = bridge.call("hang", {}).catch((e) => e);
    const newFake = await connectFake(port);
    newFake.onRequest(async () => ({ ok: true, result: "from-new", doc: null }));
    await oldFake.closed;
    const err = await pendingOnOld;
    expect(err).toBeInstanceOf(PluginError);
    expect(err.code).toBe("NOT_CONNECTED");
    expect(bridge.connected).toBe(true);
    await expect(bridge.call("x", {})).resolves.toEqual({ result: "from-new", doc: null });
  });

  it("goes disconnected when the plugin closes", async () => {
    const { bridge, port } = await setup();
    const fake = await connectFake(port);
    fake.close();
    await fake.closed;
    await expect.poll(() => bridge.connected).toBe(false);
    expect(bridge.pluginInfo).toBeNull();
  });

  it("ignores invalid frames without dropping the connection", async () => {
    const { bridge, port } = await setup();
    const fake = await connectFake(port);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fake.sendRaw("not json");
      fake.sendRaw(JSON.stringify({ type: "response", id: "r-1", ok: true }));
      await fake.ping();
      expect(logged).toHaveBeenCalledTimes(2);
      expect(bridge.connected).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("pong answers ping", async () => {
    const { port } = await setup();
    const fake = await connectFake(port);
    await expect(fake.ping()).resolves.toBeUndefined();
  });

  it("refuses a browser Origin", async () => {
    const { bridge, port } = await setup();
    for (const origin of ["http://evil.example", "https://evil.example"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
      const err = await new Promise<Error>((resolve) => ws.once("error", resolve));
      expect(err.message).toMatch(/401/);
    }
    expect(bridge.connected).toBe(false);
  });

  it("a client that never says hello does not displace the plugin and is closed with 1008", async () => {
    const { bridge, port } = await setup(2000, 100);
    const plugin = await connectFake(port);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    plugin.onRequest(async () => {
      await held;
      return { ok: true, result: "from-plugin", doc: null };
    });
    const pendingCall = bridge.call("x", {});
    const silent = new FakePlugin(port);
    fakes.push(silent);
    await silent.open();
    silent.sendRaw(JSON.stringify({ type: "ping" }));
    await silent.closed;
    expect(silent.closeCode).toBe(1008);
    expect(bridge.connected).toBe(true);
    release();
    await expect(pendingCall).resolves.toEqual({ result: "from-plugin", doc: null });
    await expect(bridge.call("y", {})).resolves.toEqual({ result: "from-plugin", doc: null });
  });

  it("ignores a hello from another plugin", async () => {
    const { bridge, port } = await setup(2000, 100);
    const plugin = await connectFake(port);
    plugin.onRequest(async () => ({ ok: true, result: "from-plugin", doc: null }));
    const other = new FakePlugin(port);
    fakes.push(other);
    await other.open();
    other.sendRaw(JSON.stringify({ type: "hello", plugin: "x", version: "1", ps: "1" }));
    await other.closed;
    expect(other.closeCode).toBe(1008);
    expect(bridge.pluginInfo).toEqual({ version: "0.1.0", ps: "27.11.0" });
    await expect(bridge.call("y", {})).resolves.toEqual({ result: "from-plugin", doc: null });
  });

  it("a valid hello takes over and only then rejects the old plugin's calls", async () => {
    const { bridge, port } = await setup();
    const oldFake = await connectFake(port);
    oldFake.onRequest(() => new Promise(() => {}));
    let settled = false;
    const pendingOnOld = bridge.call("hang", {}).catch((e) => e).finally(() => (settled = true));
    const newFake = new FakePlugin(port);
    fakes.push(newFake);
    await newFake.open();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    newFake.sendRaw(JSON.stringify({ type: "hello", plugin: "pslab", version: "0.2.0", ps: "27.11.0" }));
    const err = await pendingOnOld;
    expect(err.code).toBe("NOT_CONNECTED");
    await oldFake.closed;
    expect(bridge.pluginInfo).toEqual({ version: "0.2.0", ps: "27.11.0" });
  });

  it("rejects a call with PROTOCOL when its response fails the schema", async () => {
    const { bridge, port } = await setup();
    const fake = await connectFake(port);
    const bad = { id: 1, name: "a.psd", width: 1, height: 1, ppi: 72, profile: "sRGB", bits: null } as unknown as DocSummary;
    fake.onRequest(async () => ({ ok: true, result: 1, doc: bad }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = await bridge.call("x", {}).catch((e) => e);
      expect(err).toBeInstanceOf(PluginError);
      expect(err.code).toBe("PROTOCOL");
      expect(err.message).toMatch(/bits/);
      expect(bridge.connected).toBe(true);
    } finally {
      logged.mockRestore();
    }
  });

  it("binds once a holder in another process is killed, and calls stop saying PORT_BUSY", async () => {
    const port = await freePort();
    const holder = await holdPortInAnotherProcess(port);
    bridge = new PluginBridge({ port, timeoutMs: 2000, portRetryMs: 30 });
    await bridge.start();
    expect(bridge.waitingForPort).toBe(true);
    await expect(bridge.call("get_document", {})).rejects.toMatchObject({ code: "PORT_BUSY" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      holder.kill("SIGKILL");
      await expect.poll(() => bridge!.waitingForPort, { timeout: 2000 }).toBe(false);
    } finally {
      logged.mockRestore();
    }
    await expect(bridge.call("get_document", {})).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    await connectFake(port);
    expect(bridge.connected).toBe(true);
    await expect(bridge.call("get_document", {})).resolves.toEqual({ result: null, doc: null });
  });

  it("names the pid holding the port in the log and in PORT_BUSY", async () => {
    const port = await freePort();
    const holder = await holdPortInAnotherProcess(port);
    bridge = new PluginBridge({ port, timeoutMs: 2000, portRetryMs: 30 });
    await bridge.start();
    expect(bridge.waitingForPort).toBe(true);
    expect(bridge.portHolder).toContain(`pid ${holder.pid}`);
    const err = await bridge.call("get_document", {}).catch((e) => e);
    expect(err.code).toBe("PORT_BUSY");
    expect(err.message).toBe(
      `Port ${port} is held by ${bridge.portHolder}, which is not a current pslab server (an older pslab build, or another app). Quit it, or set PSLAB_PORT.`,
    );
  });
});

describe("resolvePort", () => {
  it("accepts 1024..65535 and falls back to 9777 with a warning otherwise", () => {
    expect(resolvePort(undefined)).toEqual({ port: 9777 });
    expect(resolvePort("9800")).toEqual({ port: 9800 });
    for (const raw of ["80", "70000", "abc", "9777.5"]) {
      const r = resolvePort(raw);
      expect(r.port).toBe(9777);
      expect(r.warning).toContain(raw);
    }
  });
});
