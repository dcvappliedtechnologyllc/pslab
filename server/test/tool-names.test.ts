import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge } from "../src/bridge.js";
import { registerSeeTools } from "../src/tools/see.js";
import { registerDevTools } from "../src/tools/dev.js";
import { registerEditTools } from "../src/tools/edit.js";
import { registerCompositeTools } from "../src/tools/composite.js";
import { registerOutputTools } from "../src/tools/output.js";
import { registerGeometryTools } from "../src/tools/geometry.js";
import { registerWorkflowTools } from "../src/tools/workflow.js";
import { registerMaskTools } from "../src/tools/masks.js";

const require = createRequire(import.meta.url);
const pluginActions = require("../../plugin/lib/actions/index.js") as Record<string, unknown>;

describe("tool names", () => {
  it("MCP tools and plugin actions match exactly", async () => {
    const bridge = new PluginBridge({ port: 0, timeoutMs: 1000 });
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerSeeTools(server, bridge);
    registerDevTools(server, bridge);
    registerEditTools(server, bridge);
    registerCompositeTools(server, bridge);
    registerOutputTools(server, bridge);
    registerGeometryTools(server, bridge);
    registerWorkflowTools(server, bridge);
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      const mcp = tools.map((t) => t.name).sort();
      expect(mcp).toEqual(Object.keys(pluginActions).sort());
      for (const name of mcp) expect(typeof pluginActions[name]).toBe("function");
      // Every tool declares all four MCP hints as booleans so hosts can warn before destructive calls.
      for (const t of tools) {
        const a = (t.annotations ?? {}) as Record<string, unknown>;
        for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          expect(typeof a[h], `${t.name}.${h}`).toBe("boolean");
        }
        if (a.readOnlyHint) expect(a.destructiveHint, `${t.name} read-only but destructive`).toBe(false);
      }
      const destructive = tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name).sort();
      expect(destructive).toEqual(["crop", "delete_layer", "export", "save", "save_psd"]);
    } finally {
      await client.close();
    }
  });
});

// The Anthropic API rejects draft-04 tuple schemas (`items: [...]`) and drops
// the whole tool; every advertised input schema must use single-schema items.
function tupleItems(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => tupleItems(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "items" && Array.isArray(v)) out.push(`${path}.items`);
      tupleItems(v, `${path}.${k}`, out);
    }
  }
}

describe("tool schemas", () => {
  it("no advertised input schema uses tuple-style items", async () => {
    const bridge = new PluginBridge({ port: 0, timeoutMs: 1000 });
    const server = new McpServer({ name: "pslab-test", version: "0.0.0" });
    registerSeeTools(server, bridge);
    registerDevTools(server, bridge);
    registerEditTools(server, bridge);
    registerCompositeTools(server, bridge);
    registerOutputTools(server, bridge);
    registerGeometryTools(server, bridge);
    registerWorkflowTools(server, bridge);
    registerMaskTools(server, bridge);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const { tools } = await client.listTools();
      const bad: string[] = [];
      for (const t of tools) tupleItems(t.inputSchema, t.name, bad);
      expect(bad).toEqual([]);
      const curves = tools.find((t) => t.name === "add_adjustment")!;
      expect(JSON.stringify(curves.inputSchema)).toContain('"minItems":2');
    } finally {
      await client.close();
    }
  });
});
