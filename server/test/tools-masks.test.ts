import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerMaskTools } from "../src/tools/masks.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("mask tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;
  let reply: unknown;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    reply = { ok: true, coverage_pct: 12.5 };
    plugin.onRequest(async (action, args) => {
      seen.push({ action, args });
      return { ok: true, result: reply, doc: null };
    });
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  it("mask_from_luminance forwards with defaults filled in", async () => {
    const res = await call("mask_from_luminance", { layer: 3, min_l: 200 });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "mask_from_luminance", args: { layer: 3, min_l: 200, max_l: 255, feather_px: 0 } }]);
    expect(JSON.parse(textOf(res))).toEqual({ result: { ok: true, coverage_pct: 12.5 }, doc: null });
  });

  it("mask_from_luminance rejects out-of-range and inverted levels without calling the plugin", async () => {
    for (const args of [
      { layer: 3, min_l: -1 },
      { layer: 3, min_l: 0, max_l: 256 },
      { layer: 3, min_l: 10.5 },
      { layer: 3, min_l: 0, feather_px: -1 },
      { layer: 3 },
    ]) {
      const res = await call("mask_from_luminance", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    const res = await call("mask_from_luminance", { layer: 3, min_l: 200, max_l: 100 });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("min_l (200) must not exceed max_l (100)");
    expect(seen).toEqual([]);
  });
});

describe("mask_gradient over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    plugin.onRequest(async (action, args) => {
      seen.push({ action, args });
      return { ok: true, result: { ok: true }, doc: null };
    });
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  const call = (args: Record<string, unknown>) => client.callTool({ name: "mask_gradient", arguments: args });

  it("forwards linear and radial gradients", async () => {
    const lin = { layer: 3, kind: "linear", from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, invert: true };
    const rad = { doc: 2, layer: 3, kind: "radial", from: { x: 10, y: 10 }, radius_px: 40 };
    expect((await call(lin)).isError).toBeFalsy();
    expect((await call(rad)).isError).toBeFalsy();
    expect(seen).toEqual([
      { action: "mask_gradient", args: lin },
      { action: "mask_gradient", args: rad },
    ]);
  });

  it("rejects a linear gradient without to, a radial one without radius_px, and bad values", async () => {
    for (const args of [
      { layer: 3, kind: "linear", from: { x: 0, y: 0 } },
      { layer: 3, kind: "linear", from: { x: 5, y: 5 }, to: { x: 5, y: 5 } },
      { layer: 3, kind: "radial", from: { x: 0, y: 0 } },
      { layer: 3, kind: "radial", from: { x: 0, y: 0 }, radius_px: 0 },
      { layer: 3, kind: "conic", from: { x: 0, y: 0 }, radius_px: 4 },
      { layer: 3, kind: "radial", radius_px: 4 },
    ]) {
      expect((await call(args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(seen).toEqual([]);
  });
});

describe("mask_from_color over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;
  const result = { ok: true, coverage_pct: 4.2, sampled_rgb: { r: 10, g: 20, b: 30 } };

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    plugin.onRequest(async (action, args) => {
      seen.push({ action, args });
      return { ok: true, result, doc: null };
    });
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  const call = (args: Record<string, unknown>) => client.callTool({ name: "mask_from_color", arguments: args });

  it("forwards a sample or an rgb with defaults filled in", async () => {
    const r1 = await call({ layer: 3, sample: { x: 10, y: 20 } });
    expect(r1.isError).toBeFalsy();
    expect(JSON.parse(textOf(r1))).toEqual({ result, doc: null });
    await call({ layer: 3, rgb: { r: 1, g: 2, b: 3 }, fuzziness: 10, feather_px: 2, invert: true });
    expect(seen).toEqual([
      { action: "mask_from_color", args: { layer: 3, sample: { x: 10, y: 20 }, fuzziness: 40, feather_px: 0 } },
      { action: "mask_from_color", args: { layer: 3, rgb: { r: 1, g: 2, b: 3 }, fuzziness: 10, feather_px: 2, invert: true } },
    ]);
  });

  it("requires exactly one of sample and rgb, and checks ranges", async () => {
    const neither = await call({ layer: 3 });
    expect(neither.isError).toBe(true);
    expect(textOf(neither)).toContain("exactly one of sample or rgb");
    const both = await call({ layer: 3, sample: { x: 1, y: 1 }, rgb: { r: 1, g: 2, b: 3 } });
    expect(both.isError).toBe(true);
    for (const args of [
      { layer: 3, rgb: { r: 256, g: 0, b: 0 } },
      { layer: 3, rgb: { r: 1.5, g: 0, b: 0 } },
      { layer: 3, rgb: { r: 0, g: 0, b: 0 }, fuzziness: 256 },
      { layer: 3, rgb: { r: 0, g: 0, b: 0 }, fuzziness: -1 },
      { layer: 3, rgb: { r: 0, g: 0, b: 0 }, feather_px: -1 },
    ]) {
      expect((await call(args)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(seen).toEqual([]);
  });
});

describe("preview_mask over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;
  let reply: unknown;
  const DOC = { id: 1, name: "a.psd", width: 3000, height: 1500, ppi: 72, profile: "sRGB", bits: 8, activeLayerId: null, layers: [] };

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    plugin.onRequest(async (action, args) => {
      seen.push({ action, args });
      return { ok: true, result: reply, doc: DOC };
    });
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  it("returns an image block and a text block like render_preview", async () => {
    reply = { has_mask: true, jpeg_base64: "SlBFRw==", preview: { w: 1000, h: 500 }, scale: 3 };
    const res = await client.callTool({ name: "preview_mask", arguments: { layer: 4 } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "preview_mask", args: { layer: 4, max_px: 1000 } }]);
    const content = res.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "image", data: "SlBFRw==", mimeType: "image/jpeg" });
    expect(JSON.parse(content[1].text as string)).toEqual({ scale: 3, preview: { w: 1000, h: 500 }, has_mask: true, doc: DOC });
    expect(content[1].text as string).not.toContain("SlBFRw==");
  });

  it("returns text only when the layer has no mask", async () => {
    reply = { has_mask: false };
    const res = await client.callTool({ name: "preview_mask", arguments: { layer: 4, max_px: 400 } });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0].text as string)).toEqual({ has_mask: false, doc: DOC });
  });

  it("rejects max_px out of range and passes plugin errors through", async () => {
    expect((await client.callTool({ name: "preview_mask", arguments: { layer: 4, max_px: 100 } })).isError).toBe(true);
    expect((await client.callTool({ name: "preview_mask", arguments: { layer: 4, max_px: 4001 } })).isError).toBe(true);
    expect(seen).toEqual([]);
    plugin.onRequest(async () => ({ ok: false, error: { code: "NO_LAYER", message: "No layer with id 4" } }));
    const res = await client.callTool({ name: "preview_mask", arguments: { layer: 4 } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("NO_LAYER: No layer with id 4");
  });
});
