import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { FakePlugin } from "./fake-plugin.js";

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
const contentOf = (res: unknown): Content => (res as { content: Content }).content;
const textOf = (res: unknown): string => contentOf(res)[0].text!;

describe("workflow tools over MCP", () => {
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
    registerWorkflowTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await plugin.connect();
    seen = [];
    reply = { ok: true };
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

  it("copy_layers_to is listed with its description", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "copy_layers_to")!;
    expect(t.description).toContain("top of dst_doc");
    expect(t.description).toContain("Background cannot be copied");
    expect(t.description).toContain("One undoable history step in dst_doc; src_doc is not changed");
  });

  it("copy_layers_to forwards its args and returns the new ids", async () => {
    reply = { layer_ids: [101, 100], names: ["Curves 1", "Light 1"] };
    const args = { src_doc: 1, dst_doc: 2, layers: [12, 11] };
    const res = await client.callTool({ name: "copy_layers_to", arguments: args });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "copy_layers_to", args }]);
    expect(JSON.parse(textOf(res)).result).toEqual(reply);
  });

  it("copy_layers_to rejects an empty layer list without calling the plugin", async () => {
    const res = await client.callTool({ name: "copy_layers_to", arguments: { src_doc: 1, dst_doc: 2, layers: [] } });
    expect(res.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("open_folder forwards path and pattern and returns the docs", async () => {
    reply = { docs: [{ id: 50, name: "IMG_2.jpg", path: "/s/IMG_2.jpg" }], count: 1, open_docs: [{ id: 50, name: "IMG_2.jpg" }] };
    const res = await client.callTool({ name: "open_folder", arguments: { path: "/s", pattern: "IMG_*.jpg" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "open_folder", args: { path: "/s", pattern: "IMG_*.jpg" } }]);
    expect(JSON.parse(textOf(res)).result).toEqual(reply);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "open_folder")!;
    expect(t.description).toContain("At most 50 files");
    expect(t.description).toContain("OPEN_FAILED");
  });

  it("open_folder refuses a relative path or a pattern with / without calling the plugin", async () => {
    const rel = await client.callTool({ name: "open_folder", arguments: { path: "shoot" } });
    expect(rel.isError).toBe(true);
    expect(textOf(rel)).toContain("INVALID_ARGS");
    const slash = await client.callTool({ name: "open_folder", arguments: { path: "/s", pattern: "a/*.jpg" } });
    expect(slash.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("compare_preview returns an image block and the metadata as text", async () => {
    reply = {
      jpeg_base64: "QUJD",
      preview: { w: 1500, h: 497 },
      half: { w: 746, h: 497 },
      left: "before",
      right: "after",
      scale: 4.02,
      layers_off: [3, 2],
    };
    const res = await client.callTool({ name: "compare_preview", arguments: { doc: 5, layer_ids_off: [3, 2] } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "compare_preview", args: { doc: 5, layer_ids_off: [3, 2], max_px: 1500 } }]);
    const [img, text] = contentOf(res);
    expect(img).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
    const meta = JSON.parse(text.text!);
    expect(meta).toEqual({ preview: { w: 1500, h: 497 }, half: { w: 746, h: 497 }, left: "before", right: "after", scale: 4.02, layers_off: [3, 2], doc: null });
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "compare_preview")!;
    expect(t.description).toContain("LEFT is \"before\"");
    expect(t.description).toContain("no history state");
  });

  it("compare_preview rejects empty layer_ids_off and out-of-range max_px without calling the plugin", async () => {
    const a = await client.callTool({ name: "compare_preview", arguments: { layer_ids_off: [] } });
    const b = await client.callTool({ name: "compare_preview", arguments: { layer_ids_off: [1], max_px: 100 } });
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("contact_sheet returns an image block and the layout as text", async () => {
    reply = {
      jpeg_base64: "U0hFRVQ=",
      sheet: { w: 1500, h: 754, cols: 2, rows: 1, cell: 738 },
      cells: [{ doc: 1, name: "a.jpg", x: 8, y: 131, w: 738, h: 492 }],
    };
    const res = await client.callTool({ name: "contact_sheet", arguments: { docs: [1, 2] } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ action: "contact_sheet", args: { docs: [1, 2], max_px: 1500 } }]);
    const [img, text] = contentOf(res);
    expect(img).toEqual({ type: "image", data: "U0hFRVQ=", mimeType: "image/jpeg" });
    expect(JSON.parse(text.text!)).toEqual({ sheet: reply.sheet, cells: reply.cells, doc: null });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["compare_preview", "contact_sheet", "copy_layers_to", "open_folder"]);
    expect(tools.find((t) => t.name === "contact_sheet")!.description).toContain("long edge of the whole sheet");
  });

  it("contact_sheet rejects 25 docs or cols 9 without calling the plugin", async () => {
    const many = await client.callTool({ name: "contact_sheet", arguments: { docs: Array.from({ length: 25 }, (_, i) => i) } });
    const wide = await client.callTool({ name: "contact_sheet", arguments: { docs: [1], cols: 9 } });
    expect(many.isError).toBe(true);
    expect(wide.isError).toBe(true);
    expect(seen).toEqual([]);
  });
});
