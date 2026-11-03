#!/usr/bin/env node
// Dev harness: runs the real pslab server (bridge on 9777 + every MCP tool)
// in-process, connected to an in-memory MCP client, and exposes one HTTP
// endpoint so a shell can call tools during bring-up without restarting
// Claude Code:
//
//   node scripts/dev-harness.mjs            # listens on 127.0.0.1:9778
//   curl -s -XPOST localhost:9778/call -d '{"name":"get_document","args":{}}'
//   curl -s localhost:9778/status
//
// Not for production: no auth, loopback only.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PluginBridge, resolvePort } from "../server/dist/bridge.js";
import { registerSeeTools } from "../server/dist/tools/see.js";
import { registerDevTools } from "../server/dist/tools/dev.js";
import { registerEditTools } from "../server/dist/tools/edit.js";
import { registerCompositeTools } from "../server/dist/tools/composite.js";
import { registerOutputTools } from "../server/dist/tools/output.js";
import { registerMaskTools } from "../server/dist/tools/masks.js";
import { registerGeometryTools } from "../server/dist/tools/geometry.js";
import { registerWorkflowTools } from "../server/dist/tools/workflow.js";

const { port } = resolvePort(process.env.PSLAB_PORT);
const bridge = new PluginBridge({ port, timeoutMs: 60000 });
const listening = await bridge.start();
console.error(`[harness] bridge on 127.0.0.1:${listening} (waitingForPort=${bridge.waitingForPort})`);

const server = new McpServer({ name: "pslab", version: "0.1.0" });
registerSeeTools(server, bridge);
registerDevTools(server, bridge);
registerEditTools(server, bridge);
registerCompositeTools(server, bridge);
registerOutputTools(server, bridge);
registerMaskTools(server, bridge);
registerGeometryTools(server, bridge);
registerWorkflowTools(server, bridge);
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "harness", version: "0" });
await client.connect(b);

const httpPort = Number(process.env.PSLAB_HARNESS_PORT || 9778);
http
  .createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj, null, 2));
    };
    try {
      if (req.method === "GET" && req.url === "/status") {
        return send(200, { connected: bridge.connected, plugin: bridge.pluginInfo, port: listening });
      }
      if (req.method === "GET" && req.url === "/tools") {
        const t = await client.listTools();
        return send(200, t.tools.map((x) => x.name));
      }
      if (req.method === "POST" && req.url === "/call") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { name, args } = JSON.parse(body || "{}");
        const t0 = Date.now();
        const r = await client.callTool({ name, arguments: args ?? {} });
        // keep images out of the terminal; write them to a file instead
        for (const c of r.content ?? []) {
          if (c.type === "image") {
            const f = `/tmp/pslab-preview-${Date.now()}.jpg`;
            (await import("node:fs")).writeFileSync(f, Buffer.from(c.data, "base64"));
            c.data = `<written ${f}>`;
          }
        }
        return send(200, { ms: Date.now() - t0, ...r });
      }
      send(404, { error: "use GET /status, GET /tools, POST /call {name,args}" });
    } catch (e) {
      send(500, { error: String(e?.message ?? e) });
    }
  })
  .listen(httpPort, "127.0.0.1", () => console.error(`[harness] http on 127.0.0.1:${httpPort}`));

process.on("SIGINT", () => bridge.stop().finally(() => process.exit(0)));
process.on("SIGTERM", () => bridge.stop().finally(() => process.exit(0)));
