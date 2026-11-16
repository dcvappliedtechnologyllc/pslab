import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerDesignTools } from "../src/tools/design.js";
import { FakePlugin } from "./fake-plugin.js";

describe("design tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerDesignTools(server, bridge);
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

  const run = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const tool = async (name: string) => (await client.listTools()).tools.find((x) => x.name === name)!;
  const WHITE = { r: 255, g: 255, b: 255 };

  // ---------- add_shape ----------

  it("add_shape forwards a rect and is an add tool", async () => {
    const args = { doc: 1, kind: "rect", bbox: { left: 370, top: 220, right: 630, bottom: 228 }, color: WHITE, name: "Bar 1", above: 3 };
    const res = await run("add_shape", args);
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "add_shape", args }]);
    const t = await tool("add_shape");
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(t.description).toContain("vector");
    expect(t.description).toContain("pixel layer");
  });

  it("add_shape forwards a line", async () => {
    const args = { kind: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 10 }, thickness_px: 3, color: WHITE, name: "L", opacity: 50 };
    const res = await run("add_shape", args);
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "add_shape", args }]);
  });

  it("add_shape refuses missing or bad geometry before forwarding", async () => {
    const cases = [
      { kind: "rect", color: WHITE, name: "x" },
      { kind: "ellipse", bbox: { left: 10, top: 0, right: 5, bottom: 5 }, color: WHITE, name: "x" },
      { kind: "line", from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, color: WHITE, name: "x" },
      { kind: "line", from: { x: 0, y: 0 }, thickness_px: 2, color: WHITE, name: "x" },
      { kind: "rect", bbox: { left: 0, top: 0, right: 5, bottom: 5 }, color: { r: 300, g: 0, b: 0 }, name: "x" },
      { kind: "rect", bbox: { left: 0, top: 0, right: 5, bottom: 5 }, color: WHITE, name: "" },
      { kind: "star", bbox: { left: 0, top: 0, right: 5, bottom: 5 }, color: WHITE, name: "x" },
    ];
    for (const args of cases) {
      const res = await run("add_shape", args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  // ---------- add_layer_style ----------

  it("add_layer_style forwards params (empty by default) and is a set tool", async () => {
    let res = await run("add_layer_style", { layer: 3, style: "drop_shadow" });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "add_layer_style", args: { layer: 3, style: "drop_shadow", params: {} } }]);
    seen = [];
    const params = { color: { r: 0, g: 0, b: 0 }, opacity: 40, angle: 120, distance_px: 6, spread_pct: 10, size_px: 12, blend: "multiply" };
    res = await run("add_layer_style", { doc: 1, layer: 3, style: "drop_shadow", params });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "add_layer_style", args: { doc: 1, layer: 3, style: "drop_shadow", params } }]);
    const t = await tool("add_layer_style");
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(t.description).toContain("kept");
    expect(t.description).toContain("PROTECTED_LAYER");
  });

  it("add_layer_style rejects unknown params, out-of-range values and unknown styles in the schema", async () => {
    for (const extra of [
      { style: "drop_shadow", params: { glow: 1 } },
      { style: "drop_shadow", params: { opacity: 120 } },
      { style: "drop_shadow", params: { blend: "dissolve" } },
      { style: "bevel" },
    ]) {
      const res = await run("add_layer_style", { layer: 3, ...extra });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(seen).toEqual([]);
  });
});
