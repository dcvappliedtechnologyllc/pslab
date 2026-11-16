import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerLayerTools } from "../src/tools/layers.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("layer tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerLayerTools(server, bridge);
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

  // ---------- select_layer ----------

  it("select_layer forwards the ids and is a set tool", async () => {
    const res = await run("select_layer", { doc: 2, layers: [5, 6] });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "select_layer", args: { doc: 2, layers: [5, 6] } }]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "select_layer")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(t.description).toContain("active_layer_ids");
    expect(t.description).toContain("no history state");
  });

  it("select_layer refuses an empty list in the schema", async () => {
    const res = await run("select_layer", { layers: [] });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  // ---------- reorder_layer ----------

  it("reorder_layer forwards exactly one target and is a set tool", async () => {
    for (const extra of [{ above: 4 }, { below: 4 }, { to: "top" }, { to: "bottom" }]) {
      seen = [];
      const res = await run("reorder_layer", { layer: 3, ...extra });
      expect(res.isError, JSON.stringify(extra)).toBeFalsy();
      expect(seen).toEqual([{ action: "reorder_layer", args: { layer: 3, ...extra } }]);
    }
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "reorder_layer")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(t.description).toContain("PROTECTED_LAYER");
    expect(t.description).toContain("directly above the Background");
  });

  it("reorder_layer refuses none or several targets before forwarding", async () => {
    for (const extra of [{}, { above: 4, below: 5 }, { above: 4, to: "top" }]) {
      const res = await run("reorder_layer", { layer: 3, ...extra });
      expect(res.isError, JSON.stringify(extra)).toBe(true);
      expect(textOf(res)).toBe("Give exactly one of above, below or to.");
    }
    const bad = await run("reorder_layer", { layer: 3, to: "middle" });
    expect(bad.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  // ---------- move_layer ----------

  it("move_layer forwards relative and absolute moves and is an edit tool", async () => {
    await run("move_layer", { layers: [3, 4], dy: 100 });
    await run("move_layer", { doc: 2, layers: [3], x: 200 });
    expect(seen).toEqual([
      { action: "move_layer", args: { layers: [3, 4], dy: 100 } },
      { action: "move_layer", args: { doc: 2, layers: [3], x: 200 } },
    ]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "move_layer")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(t.description).toContain("skipped");
    expect(t.description).toContain("PROTECTED_LAYER");
  });

  it("move_layer refuses no offset and mixed relative/absolute before forwarding", async () => {
    const none = await run("move_layer", { layers: [3] });
    expect(textOf(none)).toBe("Give dx/dy (relative) or x/y (absolute).");
    const mixed = await run("move_layer", { layers: [3], dx: 5, y: 10 });
    expect(textOf(mixed)).toBe("Give either dx/dy (relative) or x/y (absolute), not both.");
    expect(seen).toEqual([]);
  });

  // ---------- transform_layer ----------

  it("transform_layer forwards scale/rotate/centre and is an edit tool", async () => {
    const res = await run("transform_layer", { layer: 3, scale_pct: 76, cx: 540 });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "transform_layer", args: { layer: 3, scale_pct: 76, cx: 540 } }]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "transform_layer")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(t.description).toContain("positive = clockwise");
    expect(t.description).toContain("lose a little quality");
    expect(t.description).toContain("smart object");
  });

  it("transform_layer refuses no change and out-of-range values before forwarding", async () => {
    const none = await run("transform_layer", { layer: 3 });
    expect(textOf(none)).toBe("Give at least one of scale_pct, rotate_deg, cx or cy.");
    for (const bad of [{ scale_pct: 0 }, { scale_pct: 2000 }, { rotate_deg: 270 }]) {
      const res = await run("transform_layer", { layer: 3, ...bad });
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  // ---------- align_layers ----------

  it("align_layers forwards with defaults and is a set tool", async () => {
    const res = await run("align_layers", { layers: [3, 4, 5], horizontal: "center", as_group: true });
    expect(res.isError).toBeFalsy();
    await run("align_layers", { layers: [4], to: "layer", to_layer: 3, vertical: "top" });
    expect(seen).toEqual([
      { action: "align_layers", args: { layers: [3, 4, 5], horizontal: "center", as_group: true, to: "canvas" } },
      { action: "align_layers", args: { layers: [4], to: "layer", to_layer: 3, vertical: "top", as_group: false } },
    ]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "align_layers")!;
    expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(t.description).toContain("as_group");
    expect(t.description).toContain("NO_SELECTION");
  });

  it("align_layers refuses no direction and a mismatched to_layer before forwarding", async () => {
    const none = await run("align_layers", { layers: [3] });
    expect(textOf(none)).toBe("Give horizontal and/or vertical.");
    const missing = await run("align_layers", { layers: [3], to: "layer", horizontal: "left" });
    expect(textOf(missing)).toBe('Give to_layer exactly when to is "layer".');
    const stray = await run("align_layers", { layers: [3], to_layer: 4, horizontal: "left" });
    expect(textOf(stray)).toBe('Give to_layer exactly when to is "layer".');
    expect(seen).toEqual([]);
  });
});
