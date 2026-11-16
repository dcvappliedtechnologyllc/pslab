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
});
