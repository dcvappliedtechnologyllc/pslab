import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerCompositeTools } from "../src/tools/composite.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("composite tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerCompositeTools(server, bridge);
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

  it("lists select_object and copy_to with descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["blur_layer", "copy_to", "match_tone", "refine_edge", "select_object"]);
    const copy = tools.find((t) => t.name === "copy_to")!;
    expect(copy.description).toContain("cx, cy");
    expect(copy.description).toContain("profile");
    const sel = tools.find((t) => t.name === "select_object")!;
    expect(sel.description).toContain("copy_to");
    expect(sel.description).toContain("bbox is ignored");
  });

  it("copy_to schema rejects scale_pct: 0 without calling the plugin", async () => {
    const res = await client.callTool({
      name: "copy_to",
      arguments: { src_doc: 1, dst_doc: 2, transform: { scale_pct: 0, cx: 10, cy: 10 } },
    });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("copy_to rejects scale_pct above 1000", async () => {
    const res = await client.callTool({
      name: "copy_to",
      arguments: { src_doc: 1, dst_doc: 2, transform: { scale_pct: 1001, cx: 10, cy: 10 } },
    });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("copy_to forwards args with use_selection defaulting to true", async () => {
    const transform = { scale_pct: 62.5, cx: 1810.5, cy: 2240 };
    const res = await client.callTool({
      name: "copy_to",
      arguments: { src_doc: 1, src_layer: 5, dst_doc: 2, transform, name: "Mushroom" },
    });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([
      { action: "copy_to", args: { src_doc: 1, src_layer: 5, use_selection: true, dst_doc: 2, transform, name: "Mushroom" } },
    ]);
    expect(JSON.parse(textOf(res))).toEqual({ result: { layer_id: 42 }, doc: null });
  });

  it("select_object forwards args and rejects an unknown mode", async () => {
    const bbox = { left: 1, top: 2, right: 30, bottom: 40 };
    await client.callTool({ name: "select_object", arguments: { doc: 3, bbox, mode: "subject" } });
    const bad = await client.callTool({ name: "select_object", arguments: { bbox, mode: "lasso" } });
    expect(bad.isError).toBe(true);
    expect(seen).toEqual([{ action: "select_object", args: { doc: 3, bbox, mode: "subject" } }]);
  });

  it("plugin errors come back as isError with the message", async () => {
    plugin.onRequest(async () => ({ ok: false, error: { code: "NO_SELECTION", message: "no active selection" } }));
    const res = await client.callTool({
      name: "copy_to",
      arguments: { src_doc: 1, dst_doc: 2, transform: { scale_pct: 100, cx: 0, cy: 0 } },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("NO_SELECTION: no active selection");
  });

  it("finishing tools describe what they do", async () => {
    const { tools } = await client.listTools();
    const by = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(by("refine_edge")).toContain("mask");
    expect(by("match_tone")).toContain("returns");
    expect(by("blur_layer")).toContain("smart");
  });

  it("blur_layer rejects radius_px 0 and above 250 without calling the plugin", async () => {
    for (const radius_px of [0, 251]) {
      const res = await client.callTool({ name: "blur_layer", arguments: { layer: 5, radius_px } });
      expect(res.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it("refine_edge rejects a negative contract without calling the plugin", async () => {
    const res = await client.callTool({ name: "refine_edge", arguments: { layer: 5, contract_px: -1, feather_px: 1 } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("match_tone rejects a missing reference_bbox without calling the plugin", async () => {
    const res = await client.callTool({ name: "match_tone", arguments: { layer: 5 } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("finishing tools forward their args", async () => {
    const reference_bbox = { left: 10, top: 20, right: 110, bottom: 120 };
    await client.callTool({ name: "refine_edge", arguments: { doc: 2, layer: 5, contract_px: 2, feather_px: 1.5, decontaminate: true } });
    await client.callTool({ name: "match_tone", arguments: { doc: 2, layer: 5, reference_bbox } });
    await client.callTool({ name: "blur_layer", arguments: { layer: 5, radius_px: 1.2 } });
    expect(seen).toEqual([
      { action: "refine_edge", args: { doc: 2, layer: 5, contract_px: 2, feather_px: 1.5, decontaminate: true } },
      { action: "match_tone", args: { doc: 2, layer: 5, reference_bbox } },
      { action: "blur_layer", args: { layer: 5, radius_px: 1.2 } },
    ]);
  });
});
