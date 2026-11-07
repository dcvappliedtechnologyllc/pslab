import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult, hints } from "./common.js";

const box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });

function forward(bridge: PluginBridge, action: string) {
  return async (args: unknown) => {
    try {
      return toolResult(await bridge.call(action, args));
    } catch (e) {
      return toolError(e);
    }
  };
}

export function registerCompositeTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "select_object",
    {
      annotations: hints.add,
      description:
        "Select an object with Photoshop's Object Selection inside bbox (mode object; bbox in image pixels of that document), " +
        "or the main subject of the whole image with Select Subject (mode subject; bbox is ignored). " +
        "Returns the selection bounds. The selection stays active in that document " +
        "for copy_to (use_selection); the previously active document stays active. One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        bbox: box.describe("Search box in image pixels (left < right, top < bottom); ignored by mode subject"),
        mode: z.enum(["object", "subject"]),
      },
    },
    forward(bridge, "select_object"),
  );

  // copy_to suspends both documents' history in one modal scope (runSteps), so it is one undo in each.
  // Whether Photoshop accepts the second concurrent suspension is verified in the phase 3 live check.
  server.registerTool(
    "copy_to",
    {
      annotations: hints.add,
      description:
        "Copy a layer from src_doc into dst_doc as a new pixel layer and return its layer_id and bounds. " +
        "With use_selection (default true) only the part inside src_doc's active selection is copied (run select_object first). " +
        "The layer is converted to the destination document's color profile. " +
        "transform.scale_pct scales it (100 = same size); cx, cy are the image-pixel position in the destination where the " +
        "pasted object's center lands after scaling. dst_doc is left as the active document; pass doc: dst_doc to the " +
        "layer tools that follow. One undoable history step in each document.",
      inputSchema: {
        src_doc: z.number().int().describe("Source document id"),
        src_layer: z.number().int().optional().describe("Source layer id; defaults to the source document's active layer"),
        use_selection: z.boolean().default(true).describe("Copy only the selected part of the layer"),
        dst_doc: z.number().int().describe("Destination document id"),
        transform: z.object({
          scale_pct: z.number().min(1).max(1000).describe("Scale in percent, 1..1000"),
          cx: z.number().describe("Destination x in image pixels for the object's center after scaling"),
          cy: z.number().describe("Destination y in image pixels for the object's center after scaling"),
        }),
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Name for the new layer; defaults to "<source layer> from <source document>"'),
      },
    },
    forward(bridge, "copy_to"),
  );

  server.registerTool(
    "refine_edge",
    {
      annotations: hints.add,
      description:
        "Clean the edge of a pasted layer: builds a layer mask from the layer's own transparency, shrunk by contract_px " +
        "and softened by feather_px (contract first, then feather; 0 skips either), replacing any mask the layer already has. " +
        "Typical values: contract 1-3 px, feather 0.5-2 px. With decontaminate, a defringed copy named " +
        "'<name> decontaminated' is added above and the original is hidden (skipped with a warning when defringe is not recorded). " +
        "Returns ok and warnings. One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        layer: z.number().int().describe("Layer id"),
        contract_px: z.number().min(0).describe("Pixels to shrink the edge by, >= 0"),
        feather_px: z.number().min(0).describe("Edge softness in pixels, >= 0"),
        decontaminate: z.boolean().optional().describe("Also remove edge color fringe (defringe 1 px) on a copy"),
      },
    },
    forward(bridge, "refine_edge"),
  );

  server.registerTool(
    "match_tone",
    {
      annotations: hints.add,
      description:
        "Match a layer's brightness and saturation to a reference region of the composite image (reference_bbox, " +
        "image pixels; pick an area near where the layer sits, lit the same way). Measures the layer's own opaque pixels " +
        "and the reference, then adds a Hue/Saturation and a Curves adjustment clipped to the layer. " +
        "It returns the values it used (hue, saturation, lightness, curve) and the two new layer_ids, so you can report " +
        "them and soften the effect with set_layer (opacity). One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        layer: z.number().int().describe("Layer id of the object to match"),
        reference_bbox: box.describe("Reference region in image pixels (left < right, top < bottom)"),
      },
    },
    forward(bridge, "match_tone"),
  );

  server.registerTool(
    "blur_layer",
    {
      annotations: hints.add,
      description:
        "Soften a layer to match the shot's sharpness with a Gaussian blur of radius_px. The layer is converted to a " +
        "smart object first, so the blur is an editable smart filter (an existing smart object is not wrapped again). " +
        "The layer id can change: use the returned layer_id afterwards. One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        layer: z.number().int().describe("Layer id"),
        radius_px: z.number().min(0.1).max(250).describe("Blur radius in pixels, 0.1..250"),
      },
    },
    forward(bridge, "blur_layer"),
  );
}
