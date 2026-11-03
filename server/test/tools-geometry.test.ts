import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerGeometryTools } from "../src/tools/geometry.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("geometry tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerGeometryTools(server, bridge);
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

  // ---------- straighten ----------

  it("lists straighten with a description of the non-destructive rotation", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "straighten")!;
    expect(t).toBeDefined();
    expect(t.description).toContain("Background is never changed");
    expect(t.description).toContain('"Straightened"');
    expect(t.description).toContain("smart object");
    expect(t.description).toContain("positive = clockwise");
    expect(t.description).toContain("measured");
    expect(t.description).toContain("Camera Raw");
    expect(t.description).toContain("ALREADY_STRAIGHTENED");
    expect(t.description).toContain("delete_layer");
    expect(t.description).toContain("straighten first, then clean up");
  });

  it("straighten forwards angle_deg with vertical defaulting to true", async () => {
    const res = await client.callTool({ name: "straighten", arguments: { doc: 3, angle_deg: -1.5 } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "straighten", args: { doc: 3, angle_deg: -1.5, vertical: true } }]);
    expect(JSON.parse(textOf(res)).result).toEqual({ layer_id: 42 });
  });

  it("straighten forwards auto with vertical: false", async () => {
    const res = await client.callTool({ name: "straighten", arguments: { auto: true, vertical: false } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "straighten", args: { auto: true, vertical: false } }]);
  });

  it("straighten refuses neither or both of angle_deg and auto", async () => {
    for (const args of [{}, { auto: false }, { angle_deg: 2, auto: true }]) {
      const res = await client.callTool({ name: "straighten", arguments: args });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("exactly one of angle_deg or auto");
    }
    expect(seen).toEqual([]);
  });

  it("straighten rejects angle_deg outside -45..45", async () => {
    for (const angle_deg of [45.5, -46]) {
      const res = await client.callTool({ name: "straighten", arguments: { angle_deg } });
      expect(res.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  // ---------- content_aware_fill ----------

  it("lists content_aware_fill with a description of the patch layer", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "content_aware_fill")!;
    expect(t.description).toContain("Content-Aware Fill");
    expect(t.description).toContain("NEW pixel layer");
    expect(t.description).toContain("Background");
    expect(t.description).toContain("exactly one of bbox or polygon");
  });

  it("content_aware_fill forwards bbox and name", async () => {
    const bbox = { left: 10, top: 20, right: 110, bottom: 220 };
    const res = await client.callTool({ name: "content_aware_fill", arguments: { doc: 2, bbox, name: "Outlet removed" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "content_aware_fill", args: { doc: 2, bbox, name: "Outlet removed" } }]);
  });

  it("content_aware_fill forwards a polygon", async () => {
    const polygon = [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 5, y: 8 }];
    const res = await client.callTool({ name: "content_aware_fill", arguments: { polygon, name: "Patch" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "content_aware_fill", args: { polygon, name: "Patch" } }]);
  });

  it("content_aware_fill refuses neither/both regions, a short polygon or a missing name", async () => {
    const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
    const polygon = [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 5, y: 8 }];
    for (const args of [
      { name: "x" },
      { bbox, polygon, name: "x" },
      { polygon: polygon.slice(0, 2), name: "x" },
      { bbox },
      { bbox, name: "" },
    ]) {
      const res = await client.callTool({ name: "content_aware_fill", arguments: args });
      expect(res.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  // ---------- clone_from ----------

  it("lists all three geometry tools; clone_from describes the move and feather", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["clone_from", "content_aware_fill", "straighten"]);
    const t = tools.find((x) => x.name === "clone_from")!;
    expect(t.description).toContain("top-left corner");
    expect(t.description).toContain("feather_px");
    expect(t.description).toContain("NEW pixel layer");
  });

  it("clone_from forwards its args", async () => {
    const args = { doc: 1, src_bbox: { left: 0, top: 0, right: 50, bottom: 40 }, dst: { x: 100, y: 120 }, name: "Floor patch", feather_px: 8 };
    const res = await client.callTool({ name: "clone_from", arguments: args });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "clone_from", args }]);
  });

  it("clone_from rejects feather_px above 200, a missing name or a missing dst", async () => {
    const src_bbox = { left: 0, top: 0, right: 500, bottom: 500 };
    for (const args of [
      { src_bbox, dst: { x: 1, y: 1 }, name: "x", feather_px: 201 },
      { src_bbox, dst: { x: 1, y: 1 }, name: "x", feather_px: -1 },
      { src_bbox, dst: { x: 1, y: 1 } },
      { src_bbox, name: "x" },
    ]) {
      const res = await client.callTool({ name: "clone_from", arguments: args });
      expect(res.isError).toBe(true);
    }
    expect(seen).toEqual([]);
  });
});
