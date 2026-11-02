import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerEditTools } from "../src/tools/edit.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("edit tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerEditTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    plugin.onRequest(async (action, args) => {
      seen.push({ action, args });
      return { ok: true, result: { layer_id: 42 }, doc: null };
    });
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  it("lists all six edit tools with descriptions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_adjustment", "add_pixel_layer", "mask_from_polygon", "mask_from_subject", "paint_mask", "set_layer"]);
    for (const t of tools) expect((t.description ?? "").length).toBeGreaterThan(40);
    const add = tools.find((t) => t.name === "add_adjustment")!;
    for (const type of ["light", "curves", "hue_sat", "color_vibrance", "clarity_dehaze", "exposure", "brightness_contrast"]) {
      expect(add.description).toContain(type);
    }
    expect(add.description).toContain("ignores whites and blacks");
    expect(tools.find((t) => t.name === "mask_from_subject")!.description).toContain("mode subject; bbox is ignored");
  });

  it("add_adjustment schema rejects exposure: 7 without calling the plugin", async () => {
    const res = await client.callTool({ name: "add_adjustment", arguments: { type: "light", params: { exposure: 7 } } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("add_adjustment rejects contrast out of range and params that do not belong to the type", async () => {
    const r1 = await client.callTool({ name: "add_adjustment", arguments: { type: "light", params: { contrast: 101 } } });
    expect(r1.isError).toBe(true);
    const r2 = await client.callTool({ name: "add_adjustment", arguments: { type: "hue_sat", params: { exposure: 1 } } });
    expect(r2.isError).toBe(true);
    expect(textOf(r2)).toContain("exposure");
    expect(seen).toEqual([]);
  });

  it("add_adjustment forwards a valid request and returns the layer id", async () => {
    const args = { type: "light", params: { exposure: 0.6, contrast: 10 }, name: "Light", above: 3 };
    const res = await client.callTool({ name: "add_adjustment", arguments: args });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "add_adjustment", args }]);
    expect(JSON.parse(textOf(res))).toEqual({ result: { layer_id: 42 }, doc: null });
  });

  it("add_adjustment accepts curves points per channel", async () => {
    const args = { type: "curves", params: { points: { rgb: [[0, 0], [128, 121], [255, 255]] } } };
    const res = await client.callTool({ name: "add_adjustment", arguments: args });
    expect(res.isError).toBeFalsy();
    expect(seen[0].args).toEqual(args);
  });

  it("paint_mask forwards strokes untouched", async () => {
    const strokes = [
      { points: [{ x: 10.5, y: 20 }, { x: 30, y: 40.25 }], size_px: 12, hardness: 0.3, opacity: 0.8 },
      { points: [{ x: 1, y: 2 }], size_px: 0.5, hardness: 1, opacity: 0 },
    ];
    const res = await client.callTool({ name: "paint_mask", arguments: { layer: 7, strokes, color: "white" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "paint_mask", args: { layer: 7, strokes, color: "white" } }]);
  });

  it("paint_mask rejects empty strokes and hardness above 1", async () => {
    const r1 = await client.callTool({ name: "paint_mask", arguments: { layer: 7, strokes: [], color: "white" } });
    const r2 = await client.callTool({
      name: "paint_mask",
      arguments: { layer: 7, strokes: [{ points: [{ x: 1, y: 1 }], size_px: 4, hardness: 1.5, opacity: 1 }], color: "black" },
    });
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("mask_from_polygon needs at least 3 points", async () => {
    const res = await client.callTool({
      name: "mask_from_polygon",
      arguments: { layer: 7, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], feather_px: 0 },
    });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("mask_from_subject, set_layer and add_pixel_layer forward their args", async () => {
    const bbox = { left: 1, top: 2, right: 30, bottom: 40 };
    await client.callTool({ name: "mask_from_subject", arguments: { layer: 7, bbox, mode: "object" } });
    await client.callTool({ name: "set_layer", arguments: { layer: 7, opacity: 40, blend: "soft_light", mask_invert: true } });
    await client.callTool({ name: "add_pixel_layer", arguments: { name: "Paint" } });
    expect(seen).toEqual([
      { action: "mask_from_subject", args: { layer: 7, bbox, mode: "object" } },
      { action: "set_layer", args: { layer: 7, opacity: 40, blend: "soft_light", mask_invert: true } },
      { action: "add_pixel_layer", args: { name: "Paint" } },
    ]);
  });

  it("mask_from_polygon, mask_from_subject, paint_mask and set_layer forward doc", async () => {
    const bbox = { left: 1, top: 2, right: 30, bottom: 40 };
    const points = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    const strokes = [{ points: [{ x: 1, y: 2 }], size_px: 4, hardness: 1, opacity: 1 }];
    await client.callTool({ name: "mask_from_polygon", arguments: { doc: 3, layer: 7, points, feather_px: 0 } });
    await client.callTool({ name: "mask_from_subject", arguments: { doc: 3, layer: 7, bbox, mode: "subject" } });
    await client.callTool({ name: "paint_mask", arguments: { doc: 3, layer: 7, strokes, color: "black" } });
    await client.callTool({ name: "set_layer", arguments: { doc: 3, layer: 7, visible: false } });
    expect(seen.map((s) => [s.action, (s.args as { doc?: number }).doc])).toEqual([
      ["mask_from_polygon", 3],
      ["mask_from_subject", 3],
      ["paint_mask", 3],
      ["set_layer", 3],
    ]);
    const bad = await client.callTool({ name: "set_layer", arguments: { doc: 1.5, layer: 7, visible: false } });
    expect(bad.isError).toBe(true);
    expect(seen).toHaveLength(4);
  });

  it("set_layer rejects opacity above 100", async () => {
    const res = await client.callTool({ name: "set_layer", arguments: { layer: 7, opacity: 150 } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("plugin errors come back as isError with the message", async () => {
    plugin.onRequest(async () => ({ ok: false, error: { code: "NO_LAYER", message: "No layer with id 9" } }));
    const res = await client.callTool({ name: "set_layer", arguments: { layer: 9, visible: false } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("NO_LAYER: No layer with id 9");
  });
});
