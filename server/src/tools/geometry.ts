import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult, hints } from "./common.js";

const box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
const point = z.object({ x: z.number(), y: z.number() });

async function call(bridge: PluginBridge, action: string, args: unknown) {
  try {
    return toolResult(await bridge.call(action, args));
  } catch (e) {
    return toolError(e);
  }
}

export function registerGeometryTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "straighten",
    {
      annotations: hints.add,
      description:
        "Straighten a tilted photo without touching the original: the Background is never changed. A copy of it " +
        '(or of the bottom layer when there is no Background) named "Straightened" is converted to a smart object ' +
        "and rotated above it with Free Transform; corners the rotation exposes show the Background underneath, so " +
        "crop afterwards. Give exactly one of angle_deg (positive = clockwise, as Photoshop's transform angle; " +
        "-45..45) or auto: true. auto measures the tilt of the photo's near-vertical lines (door frames, walls, " +
        "window edges; vertical: false uses near-horizontal lines instead) on a downscaled copy and applies it " +
        "rounded to 0.1 degree; the result's measured field reports what it found (angle_deg, confidence, " +
        "edges_used, preview_width), and NO_EDGES means too few straight edges, so give angle_deg. " +
        "Camera Raw's Upright/geometry correction is not available (no known descriptor), so this is a plain " +
        "rotation, not a perspective fix. If the document already has a layer named \"Straightened\" it refuses " +
        "with ALREADY_STRAIGHTENED (a second copy would land under the first): delete_layer it (confirm: true) or " +
        "hide it first. Patch layers above \"Straightened\" (content_aware_fill / clone_from results) are not " +
        "rotated with it, so straighten first, then clean up. Returns layer_id, angle_deg, method. One undoable " +
        "history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        angle_deg: z
          .number()
          .min(-45)
          .max(45)
          .optional()
          .describe("Rotation in degrees, positive = clockwise; give this or auto"),
        auto: z.boolean().optional().describe("Measure the tilt from the image's straight edges; give this or angle_deg"),
        vertical: z
          .boolean()
          .default(true)
          .describe("auto: measure near-vertical lines (default) or, when false, near-horizontal ones"),
      },
    },
    async (args) => {
      if ((args.angle_deg !== undefined) === (args.auto === true)) {
        return toolError("Give exactly one of angle_deg or auto: true.");
      }
      return call(bridge, "straighten", args);
    },
  );

  server.registerTool(
    "content_aware_fill",
    {
      annotations: hints.add,
      description:
        "Remove an object or blemish with Photoshop's Content-Aware Fill, non-destructively: the visible image is " +
        "stamped onto a NEW pixel layer named name on top of the stack, the region (exactly one of bbox or polygon, " +
        "image pixels inside the canvas; draw it a little larger than the object) is grown by 2 px and filled from " +
        "its surroundings, and everything outside it is erased, so the layer holds only the patch. The Background " +
        "and other layers are untouched; hide or delete the patch layer to undo the look. Layers added later above " +
        "it are not part of the fill. Returns layer_id and the patch bounds. One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        bbox: box.optional().describe("Region to fill in image pixels (left < right, top < bottom); or give polygon"),
        polygon: z.array(point).min(3).optional().describe("Region to fill as polygon corners in image pixels; or give bbox"),
        name: z.string().min(1).describe('Name for the new patch layer, e.g. "Outlet removed"'),
      },
    },
    async (args) => {
      if ((args.bbox === undefined) === (args.polygon === undefined)) {
        return toolError("Give exactly one of bbox or polygon.");
      }
      return call(bridge, "content_aware_fill", args);
    },
  );

  server.registerTool(
    "clone_from",
    {
      annotations: hints.add,
      description:
        "Cover something with a copy of another part of the image (like the Clone Stamp, as one rectangle): the " +
        "visible image inside src_bbox is copied to a NEW pixel layer named name and moved so its top-left corner " +
        "lands at dst (image pixels; src_bbox and dst inside the canvas). feather_px (default 0, max 200, under half " +
        "the box's shorter side) adds a mask that fades the copy's edge out over that many pixels inside the box, so " +
        "it blends; 0 keeps a hard edge. The Background and other layers are untouched. Returns layer_id, bounds and " +
        "feather_px. One undoable history step.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        src_bbox: box.describe("Area to copy in image pixels (left < right, top < bottom)"),
        dst: point.describe("Where the copy's top-left corner lands, in image pixels"),
        name: z.string().min(1).describe('Name for the new layer, e.g. "Floor patch"'),
        feather_px: z.number().min(0).max(200).optional().describe("Soft edge width in pixels, 0..200; default 0"),
      },
    },
    async (args) => call(bridge, "clone_from", args),
  );
}
