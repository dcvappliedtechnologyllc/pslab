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

  server.registerTool(
    "reorder_layer",
    {
      annotations: hints.set,
      description:
        "Move a layer up or down the layer stack in doc (Layer > Arrange), without moving its pixels. Give exactly one " +
        "of: above (a layer id; it goes directly above that layer, inside that layer's group if it is in one, and is " +
        "released from any clipping group), below (a layer id; directly below it; never below the Background), or to: " +
        '"top" (top of the whole document, out of any group) or "bottom" (directly above the Background, or the ' +
        "bottom of the document when there is none). The Background itself never moves (PROTECTED_LAYER), and a " +
        "group cannot go inside itself. Already in place: nothing changes and no history state is made (moved: " +
        "false). Returns layer_id, index (0 = top of its group or of the document) and moved. One undoable history " +
        "step; the active document is unchanged afterwards.",
      inputSchema: {
        doc: docArg,
        layer: layerId.describe("The layer to move in the stack"),
        above: layerId.optional().describe("Put the layer directly above this layer id"),
        below: layerId.optional().describe("Put the layer directly below this layer id"),
        to: z.enum(["top", "bottom"]).optional().describe("top of the document, or bottom (just above the Background)"),
      },
    },
    async (args) => {
      if ([args.above, args.below, args.to].filter(given).length !== 1) {
        return toolError("Give exactly one of above, below or to.");
      }
      return call(bridge, "reorder_layer", args);
    },
  );
}
