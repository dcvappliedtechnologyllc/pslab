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

  server.registerTool(
    "move_layer",
    {
      annotations: hints.edit,
      description:
        "Move one or more layers' content on the canvas together, as one block (the Move tool), in doc. Relative: dx/dy " +
        "in image pixels (positive = right/down); repeating the call moves again. Absolute: x/y put the top-left " +
        "corner of the layers' combined bounds at that point (a missing axis does not move). Give dx/dy or x/y, not " +
        "both. Offsets are rounded to whole pixels. A listed group moves with its contents. The Background never moves " +
        "(PROTECTED_LAYER); layers without pixels (empty, or an adjustment layer without a mask) are left alone and " +
        "listed in skipped. Returns moved: [{id, bounds}] (bounds after the move), dx, dy and skipped. One undoable " +
        "history step; nothing to move makes none.",
      inputSchema: {
        doc: docArg,
        layers: z.array(layerId).min(1).max(50).describe("Layer ids to move together"),
        dx: z.number().optional().describe("Pixels to move right (negative = left)"),
        dy: z.number().optional().describe("Pixels to move down (negative = up)"),
        x: z.number().optional().describe("Absolute: left edge of the combined bounds goes here"),
        y: z.number().optional().describe("Absolute: top edge of the combined bounds goes here"),
      },
    },
    async (args) => {
      const rel = given(args.dx) || given(args.dy);
      const abs = given(args.x) || given(args.y);
      if (!rel && !abs) return toolError("Give dx/dy (relative) or x/y (absolute).");
      if (rel && abs) return toolError("Give either dx/dy (relative) or x/y (absolute), not both.");
      return call(bridge, "move_layer", args);
    },
  );

  server.registerTool(
    "transform_layer",
    {
      annotations: hints.edit,
      description:
        "Scale, rotate and/or re-centre one layer (Edit > Free Transform), in doc. scale_pct (1..1000, of the current " +
        "size, both axes) and rotate_deg (-180..180, positive = clockwise) act about the centre of the layer's bounds; " +
        "cx/cy (image pixels) then put that centre at the given point (a missing axis keeps it). Values are relative " +
        "to the layer's current state, so repeating the call scales or rotates again. Pixel layers lose a little " +
        "quality on every scale or rotate (repeated transforms blur); text, shape and smart object layers do not, so on " +
        "a pixel layer prefer one transform over several small ones. The Background is " +
        "refused (PROTECTED_LAYER), and so is a layer without pixels (EMPTY_LAYER). Returns layer_id and bounds after " +
        "the transform. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId.describe("The layer to transform"),
        scale_pct: z.number().min(1).max(1000).optional().describe("Scale in percent of the current size; default 100"),
        rotate_deg: z.number().min(-180).max(180).optional().describe("Rotation in degrees, positive = clockwise; default 0"),
        cx: z.number().optional().describe("Where the layer's centre ends up, x in image pixels; default unchanged"),
        cy: z.number().optional().describe("Where the layer's centre ends up, y in image pixels; default unchanged"),
      },
    },
    async (args) => {
      if (![args.scale_pct, args.rotate_deg, args.cx, args.cy].some(given)) {
        return toolError("Give at least one of scale_pct, rotate_deg, cx or cy.");
      }
      return call(bridge, "transform_layer", args);
    },
  );
}
