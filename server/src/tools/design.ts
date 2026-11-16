import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult, hints } from "./common.js";

const layerId = z.number().int().describe("Layer id from get_document");
const docArg = z.number().int().optional().describe("Document id; defaults to the active document");
const box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
const point = z.object({ x: z.number(), y: z.number() });
const channel = z.number().int().min(0).max(255);
const color = z.object({ r: channel, g: channel, b: channel });

async function call(bridge: PluginBridge, action: string, args: unknown) {
  try {
    return toolResult(await bridge.call(action, args));
  } catch (e) {
    return toolError(e);
  }
}

const given = (v: unknown) => v !== undefined && v !== null;

export function registerDesignTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "add_shape",
    {
      annotations: hints.add,
      description:
        "Add a solid-colour shape as a new layer in doc: kind rect or ellipse (bbox in image pixels; the ellipse fills " +
        "its bbox) or line (from and to points plus thickness_px; a rotated thin rectangle). The layer is named name, " +
        "filled with color {r,g,b} 0..255, at opacity (0..100, default 100). It lands above the active layer, or " +
        "directly above the layer id given as above (inside that layer's group, if any; never clipped). Photoshop " +
        "first tries a vector shape layer (crisp at any scale); if that is refused it paints a pixel layer instead. " +
        "Returns layer_id, kind, vector (true = shape layer, false = pixel layer) and bounds. One undoable history step.",
      inputSchema: {
        doc: docArg,
        kind: z.enum(["rect", "ellipse", "line"]),
        bbox: box.optional().describe("rect/ellipse: the box in image pixels (left < right, top < bottom)"),
        from: point.optional().describe("line: start point in image pixels"),
        to: point.optional().describe("line: end point in image pixels"),
        thickness_px: z.number().positive().optional().describe("line: thickness in pixels"),
        color: color.describe("Fill colour, r/g/b 0..255"),
        opacity: z.number().min(0).max(100).optional().describe("Layer opacity 0..100; default 100"),
        name: z.string().min(1).describe("Name of the new layer"),
        above: layerId.optional().describe("Put the new layer directly above this layer id"),
      },
    },
    async (args) => {
      if (args.kind === "line") {
        if (!given(args.from) || !given(args.to) || !given(args.thickness_px)) {
          return toolError("A line needs from, to and thickness_px.");
        }
      } else {
        if (!given(args.bbox)) return toolError(`A ${args.kind} needs bbox.`);
        const b = args.bbox!;
        if (!(b.left < b.right && b.top < b.bottom)) return toolError("bbox needs left < right and top < bottom.");
      }
      return call(bridge, "add_shape", args);
    },
  );
}
