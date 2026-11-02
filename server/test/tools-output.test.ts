import { afterEach, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { exportPath, registerOutputTools } from "../src/tools/output.js";
import { FakePlugin } from "./fake-plugin.js";

function textOf(res: unknown): string {
  return (res as { content: Array<{ text: string }> }).content[0].text;
}

describe("exportPath", () => {
  it("rejects path traversal", () => {
    const bad: Array<[string, string]> = [
      ["shoot1", "../x.jpg"],
      ["", "x.jpg"],
      ["a/b", "x.jpg"],
      ["a\\b", "x.jpg"],
      ["..", "x.jpg"],
      ["shoot1", "x.png"],
      ["shoot1", "dir/x.jpg"],
      [".", "x.jpg"],
      ["shoot1", ".jpg"],
      ["shoot1", ".hidden.jpg"],
    ];
    for (const [shoot, filename] of bad) {
      expect(() => exportPath("/root", shoot, filename)).toThrow("invalid shoot or filename");
    }
  });

  it("joins root, shoot and filename; .JPG is accepted", () => {
    expect(exportPath("/root", "shoot1", "a.jpg")).toBe(path.join("/root", "shoot1", "a.jpg"));
    expect(exportPath("/root", "shoot1", "A.JPG")).toBe(path.join("/root", "shoot1", "A.JPG"));
  });
});

describe("output tools over MCP", () => {
  let bridge: PluginBridge;
  let plugin: FakePlugin;
  let client: Client;
  let seen: Array<{ action: string; args: unknown }>;
  const root = path.join(os.tmpdir(), "pslab-exports-test");
  let savedRoot: string | undefined;

  beforeEach(async () => {
    savedRoot = process.env.PSLAB_EXPORT_ROOT;
    process.env.PSLAB_EXPORT_ROOT = root;
    bridge = new PluginBridge({ port: 0, timeoutMs: 2000 });
    const port = await bridge.start();
    plugin = new FakePlugin(port);
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerOutputTools(server, bridge);
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
    if (savedRoot === undefined) delete process.env.PSLAB_EXPORT_ROOT;
    else process.env.PSLAB_EXPORT_ROOT = savedRoot;
    plugin.close();
    await client.close();
    await bridge.stop();
  });

  it("lists crop, export and save with confirm, export root and Instagram defaults described", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["crop", "export", "save"]);
    for (const t of tools) expect(t.description).toContain("confirm: true");
    const exp = tools.find((t) => t.name === "export")!;
    expect(exp.description).toContain("pslab-exports");
    expect(exp.description).toContain("<shoot>/<filename>");
    expect(exp.description).toContain("1350");
    expect(tools.find((t) => t.name === "crop")!.description).toContain("4:5");
    const save = tools.find((t) => t.name === "save")!.description!;
    expect(save).toContain("JPEG copy (the document keeps referring to its own file)");
    expect(save).toContain("PSD (layers kept; the document then refers to that file)");
  });

  it("refuses without confirm", async () => {
    const calls = [
      { name: "crop", arguments: { ratio: "4:5" }, verb: "crop" },
      { name: "export", arguments: { shoot: "s", filename: "a.jpg" }, verb: "export" },
      { name: "export", arguments: { shoot: "s", filename: "a.jpg", confirm: false }, verb: "export" },
      { name: "save", arguments: { format: "psd" }, verb: "save" },
    ];
    for (const c of calls) {
      const res = await client.callTool({ name: c.name, arguments: c.arguments });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(`Set confirm: true to ${c.verb}.`);
    }
    expect(seen.length).toBe(0);
  });

  it("export rejects path traversal without calling the plugin", async () => {
    for (const a of [
      { shoot: "s", filename: "../x.jpg" },
      { shoot: "", filename: "x.jpg" },
      { shoot: "a/b", filename: "x.jpg" },
      { shoot: "s", filename: "x.png" },
    ]) {
      const res = await client.callTool({ name: "export", arguments: { ...a, confirm: true } });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("invalid shoot or filename");
    }
    expect(seen.length).toBe(0);
  });

  it("builds path under root with Instagram defaults", async () => {
    const res = await client.callTool({ name: "export", arguments: { shoot: "nov1", filename: "hero.jpg", confirm: true } });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([
      { action: "export", args: { path: path.join(root, "nov1", "hero.jpg"), long_edge_px: 1350, quality: 10 } },
    ]);
  });

  it("export passes doc, long_edge_px and quality", async () => {
    await client.callTool({
      name: "export",
      arguments: { doc: 3, shoot: "nov1", filename: "a.jpg", long_edge_px: 2048, quality: 12, confirm: true },
    });
    expect(seen[0].args).toEqual({ doc: 3, path: path.join(root, "nov1", "a.jpg"), long_edge_px: 2048, quality: 12 });
  });

  it("export rejects long_edge_px out of range", async () => {
    const res = await client.callTool({
      name: "export",
      arguments: { shoot: "s", filename: "a.jpg", long_edge_px: 9000, confirm: true },
    });
    expect(res.isError).toBe(true);
    expect(seen.length).toBe(0);
  });

  it("crop requires exactly one of ratio or bbox", async () => {
    const bbox = { left: 0, top: 0, right: 10, bottom: 10 };
    const none = await client.callTool({ name: "crop", arguments: { confirm: true } });
    const both = await client.callTool({ name: "crop", arguments: { ratio: "4:5", bbox, confirm: true } });
    const badRatio = await client.callTool({ name: "crop", arguments: { ratio: "4x5", confirm: true } });
    expect(none.isError).toBe(true);
    expect(both.isError).toBe(true);
    expect(badRatio.isError).toBe(true);
    expect(seen.length).toBe(0);
    await client.callTool({ name: "crop", arguments: { ratio: "4:5", confirm: true } });
    await client.callTool({ name: "crop", arguments: { doc: 2, bbox, confirm: true } });
    expect(seen).toEqual([
      { action: "crop", args: { ratio: "4:5" } },
      { action: "crop", args: { doc: 2, bbox } },
    ]);
  });

  it("save checks path is absolute and matches format", async () => {
    for (const a of [
      { format: "psd", path: "rel/a.psd" },
      { format: "psd", path: "/abs/a.jpg" },
      { format: "jpg", path: "/abs/a.png" },
    ]) {
      const res = await client.callTool({ name: "save", arguments: { ...a, confirm: true } });
      expect(res.isError).toBe(true);
    }
    expect(seen.length).toBe(0);
    await client.callTool({ name: "save", arguments: { format: "psd", confirm: true } });
    await client.callTool({ name: "save", arguments: { format: "jpg", path: "/abs/A.JPG", confirm: true } });
    expect(seen).toEqual([
      { action: "save", args: { format: "psd" } },
      { action: "save", args: { format: "jpg", path: "/abs/A.JPG" } },
    ]);
  });
});
