import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult, hints } from "./common.js";

const layerId = z.number().int().describe("Layer id from get_document");
const docArg = z
  .number()
  .int()
  .optional()
  .describe("Document id the layers are in; defaults to the active document");

async function call(bridge: PluginBridge, action: string, args: unknown) {
  try {
    return toolResult(await bridge.call(action, args));
  } catch (e) {
    return toolError(e);
  }
}

const given = (v: unknown) => v !== undefined && v !== null;

export function registerLayerTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "select_layer",
    {
      annotations: hints.set,
      description:
        "Select one or more layers in doc (as clicking and shift-clicking them in the Layers panel), and make doc the " +
        "active document. The first id becomes the active layer. Use it before a tool that acts on the selected " +
        "layers, or to show the user which layers you mean. Changes no pixels and adds no history state. Returns " +
        "active_layer_ids read back from Photoshop.",
      inputSchema: {
        doc: docArg,
        layers: z.array(layerId).min(1).max(50).describe("Layer ids to select; the first becomes the active layer"),
      },
    },
    async (args) => call(bridge, "select_layer", args),
  );
}
