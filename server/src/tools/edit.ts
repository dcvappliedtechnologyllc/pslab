import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult } from "./common.js";

const box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
const point = z.object({ x: z.number(), y: z.number() });
const layerId = z.number().int().describe("Layer id from get_document");
const docArg = z
  .number()
  .int()
  .optional()
  .describe("Document id the layer is in; defaults to the active document. After copy_to, pass the destination doc id");
const slider = z.number().min(-100).max(100).optional();
// A curve point is [x, y] with both in 0..255. Expressed as a fixed-length
// number array, not a tuple: a tuple serialises to draft-04 `items: [...]`,
// which the Anthropic API rejects and the whole tool is then dropped.
const curve = z.array(z.array(z.number().min(0).max(255)).length(2)).min(2).optional();

const params = z
  .object({
    exposure: z.number().min(-5).max(5).optional(),
    contrast: slider,
    highlights: slider,
    shadows: slider,
    whites: slider,
    blacks: slider,
    hue: z.number().min(-180).max(180).optional(),
    saturation: slider,
    lightness: slider,
    vibrance: slider,
    temperature: slider,
    tint: slider,
    clarity: slider,
    dehaze: slider,
    brightness: slider,
    offset: z.number().min(-0.5).max(0.5).optional(),
    gamma: z.number().min(0.01).max(9.99).optional(),
    points: z.object({ rgb: curve, red: curve, green: curve, blue: curve }).strict().optional(),
  })
  .strict();

const PARAMS_BY_TYPE = {
  light: ["exposure", "contrast", "highlights", "shadows", "whites", "blacks"],
  curves: ["points"],
  hue_sat: ["hue", "saturation", "lightness"],
  color_vibrance: ["vibrance", "saturation", "temperature", "tint"],
  clarity_dehaze: ["clarity", "dehaze"],
  exposure: ["exposure", "offset", "gamma"],
  brightness_contrast: ["brightness", "contrast"],
} as const;

type AdjustmentType = keyof typeof PARAMS_BY_TYPE;
const TYPES = Object.keys(PARAMS_BY_TYPE) as [AdjustmentType, ...AdjustmentType[]];

const stroke = z.object({
  points: z.array(point).min(1).describe("Stroke path in image pixels"),
  size_px: z.number().positive().describe("Brush diameter in image pixels"),
  hardness: z.number().min(0).max(1).describe("0 = soft edge, 1 = hard edge"),
  opacity: z.number().min(0).max(1),
});

function forward(bridge: PluginBridge, action: string) {
  return async (args: unknown) => {
    try {
      return toolResult(await bridge.call(action, args));
    } catch (e) {
      return toolError(e);
    }
  };
}

export function registerEditTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "add_adjustment",
    {
      description:
        "Add an adjustment layer (one undoable history step) and return its layer_id. " +
        "Types and their params (all optional, default 0): " +
        "light: exposure (-5..5), contrast, highlights, shadows, whites, blacks (-100..100); " +
        "curves: points per channel {rgb|red|green|blue: [[x,y],...]} with x,y in 0..255; " +
        "hue_sat: hue (-180..180), saturation, lightness; " +
        "color_vibrance: vibrance, saturation, temperature, tint; " +
        "clarity_dehaze: clarity, dehaze; " +
        "exposure: exposure (-5..5), offset (-0.5..0.5), gamma (0.01..9.99, default 1); " +
        "brightness_contrast: brightness, contrast. " +
        "above puts the new layer directly above that layer; clip_to clips it to that layer (and places it above it). " +
        "light may come back as a group holding Exposure and Curves layers (the returned layer_id is the group); that fallback, " +
        "used when the recorded descriptor is absent, ignores whites and blacks. " +
        "color_vibrance and clarity_dehaze can return NOT_SUPPORTED.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        type: z.enum(TYPES),
        params: params.default({}).describe("Values for the chosen type; see the description"),
        clip_to: layerId.optional().describe("Layer id to clip the new layer to"),
        name: z.string().min(1).optional().describe("Name for the new layer"),
        above: layerId.optional().describe("Layer id the new layer goes directly above"),
      },
    },
    async (args) => {
      const allowed: readonly string[] = PARAMS_BY_TYPE[args.type];
      const extra = Object.keys(args.params ?? {}).filter((k) => !allowed.includes(k));
      if (extra.length > 0) {
        return toolError(
          `params ${extra.join(", ")} do not apply to ${args.type}; it takes ${allowed.join(", ")}`,
        );
      }
      return forward(bridge, "add_adjustment")(args);
    },
  );

  server.registerTool(
    "add_pixel_layer",
    {
      description: "Add an empty pixel layer with the given name (one undoable history step) and return its layer_id.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        name: z.string().min(1).describe("Layer name"),
      },
    },
    forward(bridge, "add_pixel_layer"),
  );

  server.registerTool(
    "mask_from_polygon",
    {
      description:
        "Replace a layer's mask with a polygon: white inside, black outside (inverted when invert is true), " +
        "edge softened by feather_px. Points are image pixels of that document (doc, default the active one). " +
        "The active document is unchanged afterwards. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        points: z.array(point).min(3).describe("Polygon corners in image pixels"),
        feather_px: z.number().min(0).describe("Edge softness in image pixels; 0 for a hard edge"),
        invert: z.boolean().optional().describe("Black inside, white outside"),
      },
    },
    forward(bridge, "mask_from_polygon"),
  );

  server.registerTool(
    "mask_from_subject",
    {
      description:
        "Add a layer mask from Photoshop's Object Selection limited to bbox, in image pixels of that document (mode object), " +
        "or Select Subject on the whole image (mode subject; bbox is ignored). doc defaults to the active document. " +
        "The layer must not already have a mask. " +
        "The active document is unchanged afterwards. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        bbox: box.describe("Search box in image pixels"),
        mode: z.enum(["subject", "object"]),
      },
    },
    forward(bridge, "mask_from_subject"),
  );

  server.registerTool(
    "paint_mask",
    {
      description:
        "Paint brush strokes onto a layer's mask in white (reveal) or black (hide). Strokes composite onto the existing mask; " +
        "a layer without a mask starts from a white mask. Stroke points and size_px are image pixels of that document " +
        "(doc, default the active one). The active document is unchanged afterwards. " +
        "All strokes in one call are one undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        strokes: z.array(stroke).min(1),
        color: z.enum(["white", "black"]),
      },
    },
    forward(bridge, "paint_mask"),
  );

  server.registerTool(
    "set_layer",
    {
      description:
        "Change a layer's opacity (0..100), blend mode (e.g. normal, multiply, screen, overlay, soft_light, luminosity), " +
        "visibility or name, and/or invert its mask (mask_invert: true), in doc (default the active document). " +
        "The active document is unchanged afterwards. One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        opacity: z.number().min(0).max(100).optional(),
        blend: z.string().min(1).optional().describe("Blend mode name"),
        visible: z.boolean().optional(),
        name: z.string().min(1).optional(),
        mask_invert: z.boolean().optional().describe("Invert the layer mask"),
      },
    },
    forward(bridge, "set_layer"),
  );
}
