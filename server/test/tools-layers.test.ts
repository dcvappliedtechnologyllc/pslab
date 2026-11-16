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
});
