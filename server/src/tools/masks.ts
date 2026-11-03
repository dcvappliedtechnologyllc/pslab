import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult } from "./common.js";

type MaskPreviewResult =
  | { has_mask: false }
  | { has_mask: true; jpeg_base64: string; preview: { w: number; h: number }; scale: number };

const layerId = z.number().int().describe("Layer id from get_document");
const docArg = z
  .number()
  .int()
  .optional()
  .describe("Document id the layer is in; defaults to the active document");
const point = z.object({ x: z.number(), y: z.number() });
const level = z.number().int().min(0).max(255);
const feather = z.number().min(0).default(0).describe("Edge softness in image pixels; 0 for a hard edge");
const invert = z.boolean().optional().describe("Swap revealed and hidden areas");

function forward(bridge: PluginBridge, action: string) {
  return async (args: unknown) => {
    try {
      return toolResult(await bridge.call(action, args));
    } catch (e) {
      return toolError(e);
    }
  };
}

export function registerMaskTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "mask_from_luminance",
    {
      description:
        "Replace a layer's mask with a luminosity range of the composite image: white where min_l <= L <= max_l " +
        "(L = 0.2126 R + 0.7152 G + 0.0722 B, 0..255), black elsewhere; feather_px softens the edge, invert swaps. " +
        "Use it to target highlights (e.g. min_l 200) or shadows (max_l 60). Returns coverage_pct, the percentage of " +
        "the image the mask reveals. doc defaults to the active document, which is unchanged afterwards. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        min_l: level.describe("Lowest luminance revealed, 0..255"),
        max_l: level.default(255).describe("Highest luminance revealed, 0..255"),
        feather_px: feather,
        invert,
      },
    },
    async (args) => {
      if (args.min_l > args.max_l) return toolError(`INVALID_ARGS: min_l (${args.min_l}) must not exceed max_l (${args.max_l})`);
      return forward(bridge, "mask_from_luminance")(args);
    },
  );

  server.registerTool(
    "mask_gradient",
    {
      description:
        "Replace a layer's mask with a gradient. linear: white at from, black at to, a straight ramp along from->to and " +
        "flat beyond both ends (to is required). radial: white at from, black at radius_px from it, smooth (smoothstep) " +
        "falloff (radius_px is required). invert swaps white and black. Points are image pixels of doc (default the " +
        "active document, which is unchanged afterwards). One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        kind: z.enum(["linear", "radial"]),
        from: point.describe("Where the mask is white, in image pixels"),
        to: point.optional().describe("linear only: where the mask reaches black"),
        radius_px: z.number().positive().optional().describe("radial only: distance from from at which the mask is black"),
        invert,
      },
    },
    async (args) => {
      if (args.kind === "linear" && !args.to) return toolError("INVALID_ARGS: a linear gradient needs to");
      if (args.kind === "linear" && args.to && args.to.x === args.from.x && args.to.y === args.from.y) {
        return toolError("INVALID_ARGS: from and to must differ");
      }
      if (args.kind === "radial" && args.radius_px === undefined) return toolError("INVALID_ARGS: a radial gradient needs radius_px");
      return forward(bridge, "mask_gradient")(args);
    },
  );

  server.registerTool(
    "mask_from_color",
    {
      description:
        "Replace a layer's mask with a colour range of the composite image. Give exactly one of sample (a point in image " +
        "pixels; the 5x5 mean around it is used) or rgb. The mask is white where every channel is within fuzziness of " +
        "the colour, fading linearly to black at twice fuzziness; feather_px softens the edge, invert swaps. Returns " +
        "coverage_pct (percentage revealed) and sampled_rgb (the colour used). doc defaults to the active document, " +
        "which is unchanged afterwards. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        sample: point.optional().describe("Point to sample, in image pixels; omit when rgb is given"),
        rgb: z.object({ r: level, g: level, b: level }).optional().describe("Target colour; omit when sample is given"),
        fuzziness: z.number().min(0).max(255).default(40).describe("Per-channel tolerance, 0..255"),
        feather_px: feather,
        invert,
      },
    },
    async (args) => {
      if ((args.sample === undefined) === (args.rgb === undefined)) {
        return toolError("INVALID_ARGS: pass exactly one of sample or rgb");
      }
      return forward(bridge, "mask_from_color")(args);
    },
  );

  server.registerTool(
    "preview_mask",
    {
      description:
        "Show a layer's mask as a downscaled greyscale JPEG: white = revealed, black = hidden. Read-only. Returns " +
        "scale = image pixels per preview pixel (multiply preview coordinates by scale to get image pixels) and " +
        "has_mask; a layer without a mask returns has_mask false and no image. doc defaults to the active document.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        max_px: z.number().int().min(200).max(4000).default(1000).describe("Long edge of the preview in pixels"),
      },
    },
    async (args) => {
      try {
        const { result, doc } = await bridge.call("preview_mask", args);
        const r = result as MaskPreviewResult;
        if (!r.has_mask) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ has_mask: false, doc }) }] };
        }
        return {
          content: [
            { type: "image" as const, data: r.jpeg_base64, mimeType: "image/jpeg" },
            {
              type: "text" as const,
              text: JSON.stringify({ scale: r.scale, preview: r.preview, has_mask: true, doc }),
            },
          ],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
