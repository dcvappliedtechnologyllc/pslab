import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerSeeTools } from "../src/tools/see.js";
import { registerDevTools } from "../src/tools/dev.js";
import { FakePlugin } from "./fake-plugin.js";
import type { DocSummary } from "../src/protocol.js";

const DOC: DocSummary = {
  id: 1,
  name: "a.psd",
  width: 100,
  height: 50,
  ppi: 72,
  profile: "sRGB",
  bits: 8,
  activeLayerId: null,
  layers: [],
};

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("see/dev tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;

  beforeEach(async () => {
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerSeeTools(server, bridge);
    registerDevTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  afterEach(async () => {
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  it("get_document returns doc summary and open_docs", async () => {
    await plugin.connect();
    let seen: unknown;
    plugin.onRequest(async (action, args) => {
      seen = { action, args };
      return { ok: true, result: { open_docs: [{ id: 1, name: "a.psd" }] }, doc: DOC };
    });
    const res = await client.callTool({ name: "get_document", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ result: { open_docs: [{ id: 1, name: "a.psd" }] }, doc: DOC });
    expect((seen as { action: string }).action).toBe("get_document");
  });

  it("get_document puts the requested document's summary in doc only once", async () => {
    await plugin.connect();
    const other: DocSummary = { ...DOC, id: 2, name: "b.psd" };
    const open_docs = [{ id: 1, name: "a.psd" }, { id: 2, name: "b.psd" }];
    // the plugin returns the summary of doc 2 plus open_docs; the frame's doc is the active doc 1
    plugin.onRequest(async () => ({ ok: true, result: { ...other, open_docs }, doc: DOC }));
    const res = await client.callTool({ name: "get_document", arguments: { doc: 2 } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res))).toEqual({ result: { open_docs }, doc: other });
    expect(textOf(res).match(/"layers"/g)).toHaveLength(1);
  });

  it("open_document forwards an absolute path and refuses a relative one", async () => {
    await plugin.connect();
    let seen: unknown;
    plugin.onRequest(async (action, args) => {
      seen = { action, args };
      return { ok: true, result: { ...DOC, id: 7, name: "new.jpg", open_docs: [{ id: 7, name: "new.jpg" }] }, doc: DOC };
    });
    const bad = await client.callTool({ name: "open_document", arguments: { path: "new.jpg" } });
    expect(bad.isError).toBe(true);
    expect(seen).toBeUndefined();
    const res = await client.callTool({ name: "open_document", arguments: { path: "/tmp/new.jpg" } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual({ action: "open_document", args: { path: "/tmp/new.jpg" } });
    expect(JSON.parse(textOf(res)).doc.id).toBe(7);
  });

  it("get_document forwards the doc argument", async () => {
    await plugin.connect();
    let args: unknown;
    plugin.onRequest(async (_a, a) => {
      args = a;
      return { ok: true, result: {}, doc: null };
    });
    await client.callTool({ name: "get_document", arguments: { doc: 7 } });
    expect(args).toEqual({ doc: 7 });
  });

  it("get_document when disconnected returns isError with the connect message", async () => {
    const res = await client.callTool({ name: "get_document", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("NOT_CONNECTED: Photoshop plugin not connected. Open Plugins > pslab in Photoshop.");
  });

  it("dev_events passes clear and returns events", async () => {
    await plugin.connect();
    let args: unknown;
    plugin.onRequest(async (_a, a) => {
      args = a;
      return { ok: true, result: { events: [{ e: 1 }] }, doc: null };
    });
    const res = await client.callTool({ name: "dev_events", arguments: { clear: true } });
    expect(args).toEqual({ clear: true });
    expect(JSON.parse(textOf(res)).result).toEqual({ events: [{ e: 1 }] });
  });

  it("plugin errors become isError with the plugin message", async () => {
    await plugin.connect();
    plugin.onRequest(async () => ({ ok: false, error: { code: "NO_DOC", message: "No document open" } }));
    const res = await client.callTool({ name: "get_document", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("NO_DOC: No document open");
  });

  it("render_preview returns an image block and a text block with scale, without duplicating base64", async () => {
    await plugin.connect();
    let seen: unknown;
    plugin.onRequest(async (action, args) => {
      seen = { action, args };
      return {
        ok: true,
        result: {
          jpeg_base64: "SlBFRw==",
          preview: { w: 100, h: 50 },
          region: { left: 0, top: 0, right: 3000, bottom: 50 },
          scale: 30,
        },
        doc: DOC,
      };
    });
    const res = await client.callTool({
      name: "render_preview",
      arguments: { region: { left: -10, top: 0, right: 4000, bottom: 50 } },
    });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "image", data: "SlBFRw==", mimeType: "image/jpeg" });
    expect(content[1].type).toBe("text");
    const text = JSON.parse(content[1].text as string);
    expect(text).toEqual({
      scale: 30,
      preview: { w: 100, h: 50 },
      region: { left: 0, top: 0, right: 3000, bottom: 50 },
      doc: DOC,
    });
    expect(content[1].text as string).not.toContain("SlBFRw==");
    expect(seen).toEqual({
      action: "render_preview",
      args: { region: { left: -10, top: 0, right: 4000, bottom: 50 }, max_px: 1500 },
    });
  });

  it("render_preview rejects max_px out of range", async () => {
    await plugin.connect();
    const res = await client.callTool({ name: "render_preview", arguments: { max_px: 100 } });
    expect(res.isError).toBe(true);
  });

  it("render_preview passes plugin errors through", async () => {
    await plugin.connect();
    plugin.onRequest(async () => ({ ok: false, error: { code: "EMPTY_REGION", message: "Region is empty" } }));
    const res = await client.callTool({ name: "render_preview", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe("EMPTY_REGION: Region is empty");
  });

  it("region_stats forwards bbox and layer and returns the normal result", async () => {
    await plugin.connect();
    let seen: unknown;
    const stats = {
      mean: { r: 1, g: 2, b: 3, l: 1.9 },
      histogram_l: new Array(32).fill(0),
      clipped_high_pct: 0,
      clipped_low_pct: 100,
      px_sampled: 4,
      bbox: { left: 0, top: 0, right: 2, bottom: 2 },
      layer: 3,
    };
    plugin.onRequest(async (action, args) => {
      seen = { action, args };
      return { ok: true, result: stats, doc: DOC };
    });
    const bbox = { left: 0, top: 0, right: 2, bottom: 2 };
    const res = await client.callTool({ name: "region_stats", arguments: { bbox, layer: 3 } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual({ action: "region_stats", args: { bbox, layer: 3 } });
    expect(JSON.parse(textOf(res))).toEqual({ result: stats, doc: DOC });
  });
});
