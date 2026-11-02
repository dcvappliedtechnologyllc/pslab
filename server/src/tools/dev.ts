import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult } from "./common.js";

export function registerDevTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "dev_events",
    {
      description:
        "Developer tool: returns Photoshop events recorded since the last clear (batchPlay descriptors), for discovering descriptors. clear:true empties the buffer after returning.",
      inputSchema: { clear: z.boolean().optional().describe("Empty the buffer after returning") },
    },
    async (args) => {
      try {
        return toolResult(await bridge.call("dev_events", args));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
