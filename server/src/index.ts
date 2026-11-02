import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PluginBridge, resolvePort } from "./bridge.js";
import { registerSeeTools } from "./tools/see.js";
import { registerDevTools } from "./tools/dev.js";
import { registerEditTools } from "./tools/edit.js";
import { registerCompositeTools } from "./tools/composite.js";
import { registerOutputTools } from "./tools/output.js";

// stdout is the MCP protocol channel: log to stderr only.
async function main(): Promise<void> {
  const { port, warning } = resolvePort(process.env.PSLAB_PORT);
  if (warning) console.error(`[pslab] ${warning}`);
  const bridge = new PluginBridge({ port, timeoutMs: 60000 });
  // Every MCP host starts its own pslab (Claude Desktop starts two). The first
  // owns the port; the rest follow it and forward tool calls there, retrying
  // the bind every 5 s so one of them takes over when the owner exits. Only a
  // port held by something that is not pslab makes tools answer PORT_BUSY.
  const listening = await bridge.start();
  if (bridge.mode === "follower") {
    console.error(`[pslab] following owner pid ${bridge.ownerPid} on 127.0.0.1:${listening}`);
  } else if (bridge.mode === "busy") {
    const holder = bridge.portHolder ? ` by ${bridge.portHolder}` : " by another process";
    console.error(`[pslab] port ${listening} is held${holder}, which is not pslab; retrying every 5 s`);
  } else {
    console.error(`[pslab] bridge listening on 127.0.0.1:${listening}`);
  }

  const server = new McpServer({ name: "pslab", version: "0.1.0" });
  registerSeeTools(server, bridge);
  registerDevTools(server, bridge);
  registerEditTools(server, bridge);
  registerCompositeTools(server, bridge);
  registerOutputTools(server, bridge);

  let shuttingDown = false;
  const shutdown = (why: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[pslab] ${why}; shutting down`);
    void bridge.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // The host (Claude Desktop, Claude Code) owns stdin. When it goes away the
  // server must exit too, or it lingers as an orphan that keeps the port: every
  // later pslab server would follow it, and its calls would reach a server no
  // host is talking to and that nobody can see or quit.
  // The SDK transport does not watch for stdin ending, so do it here.
  process.stdin.on("end", () => shutdown("stdin closed (host gone)"));
  process.stdin.on("close", () => shutdown("stdin closed (host gone)"));

  await server.connect(new StdioServerTransport());
  // connect() installs its own transport.onclose; the protocol-level hook survives it.
  server.server.onclose = () => shutdown("MCP transport closed");
  console.error("[pslab] MCP server ready on stdio");
}

main().catch((e) => {
  console.error("[pslab] fatal:", e);
  process.exit(1);
});
