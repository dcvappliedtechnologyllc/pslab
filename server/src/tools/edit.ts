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

const level = z.number().int().min(0).max(255).optional();
const levelsChannel = z
  .object({
    in_black: level.describe("Input black point, default 0"),
    in_white: level.describe("Input white point, default 255"),
    gamma: z.number().min(0.1).max(9.99).optional().describe("Midtone gamma, default 1"),
    out_black: level.describe("Output black, default 0"),
    out_white: level.describe("Output white, default 255"),
  })
  .strict()
  .optional();

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
    rgb: levelsChannel,
    red: levelsChannel,
    green: levelsChannel,
    blue: levelsChannel,
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
  levels: ["rgb", "red", "green", "blue"],
} as const;

type AdjustmentType = keyof typeof PARAMS_BY_TYPE;
const TYPES = Object.keys(PARAMS_BY_TYPE) as [AdjustmentType, ...AdjustmentType[]];

// A message when params hold keys that do not belong to type, else null.
function paramsProblem(type: AdjustmentType, given: Record<string, unknown> | undefined): string | null {
  const allowed: readonly string[] = PARAMS_BY_TYPE[type];
  const extra = Object.keys(given ?? {}).filter((k) => !allowed.includes(k));
  if (extra.length > 0) return `params ${extra.join(", ")} do not apply to ${type}; it takes ${allowed.join(", ")}`;
  if (type === "levels") {
    for (const ch of ["rgb", "red", "green", "blue"]) {
      const v = (given ?? {})[ch] as { in_black?: number; in_white?: number; out_black?: number; out_white?: number } | undefined;
      if (!v) continue;
      const inB = v.in_black ?? 0;
      const inW = v.in_white ?? 255;
      const outB = v.out_black ?? 0;
      const outW = v.out_white ?? 255;
      if (!(inB < inW)) return `levels ${ch}: in_black (${inB}) must be below in_white (${inW})`;
      if (!(outB <= outW)) return `levels ${ch}: out_black (${outB}) must not exceed out_white (${outW})`;
    }
  }
  return null;
}

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
        "brightness_contrast: brightness, contrast; " +
        "levels: per channel {rgb|red|green|blue: {in_black, in_white, gamma, out_black, out_white}}, integers 0..255 " +
        "(defaults 0, 255, 0, 255) and gamma 0.1..9.99 (default 1), in_black below in_white, out_black at most out_white; " +
        "lowering one channel's in_white brightens that channel (e.g. green/blue in_white < 255 removes a warm cast). " +
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
      const problem = paramsProblem(args.type, args.params);
      if (problem) return toolError(problem);
      return forward(bridge, "add_adjustment")(args);
    },
  );

  server.registerTool(
    "set_adjustment",
    {
      description:
        "Change the values of an existing adjustment layer in place (one undoable history step), instead of stacking a new one. " +
        "type must match the layer (light, curves, hue_sat, exposure, brightness_contrast, color_vibrance, clarity_dehaze, levels); " +
        "params are the same as add_adjustment's for that type, and replace the layer's values: params left out go back to their " +
        "defaults (0, gamma 1, identity curve or levels). Errors: NOT_ADJUSTMENT for a pixel layer, group or smart object; " +
        "TYPE_MISMATCH when type is not the layer's kind (get_document shows it: light, curves, hueSaturation, exposure, " +
        "brightnessContrast, vibrance, clarity, levels). The active document is unchanged afterwards. Returns {ok, applied}.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        type: z.enum(TYPES),
        params: params.default({}).describe("New values for the layer's type; see add_adjustment"),
      },
    },
    async (args) => {
      const problem = paramsProblem(args.type, args.params);
      if (problem) return toolError(problem);
      return forward(bridge, "set_adjustment")(args);
    },
  );

  server.registerTool(
    "white_balance",
    {
      description:
        "Neutralise a colour cast from a patch that should be neutral. bbox is a box in image pixels around a grey or white " +
        "surface in the photo (a white wall, marble, a grey card), not a light source or a coloured object. RGB documents only. " +
        "The patch's mean RGB is measured on the Background layer's own pixels; a Levels layer is then added directly above " +
        "the Background layer (above the bottom-most layer when there is no Background), so it corrects the photo but not " +
        "pasted or retouched layers above it. It lifts the weaker channels (per-channel input white point) to match the " +
        "brightest, so nothing clips. strength (0 < strength <= 1, default 1) scales the whole correction. keep_warmth " +
        "(0..1, default 0) keeps part of a warm cast: it holds back only the red-blue (temperature) part of the correction, " +
        "e.g. keep_warmth 0.5 keeps half the red-blue gap; green (tint) is always fully corrected, and a cool cast ignores it. " +
        "Any selection is cleared first. One undoable history step (the Levels layer, named name, default \"White balance\"); " +
        "the active document is unchanged afterwards. Returns levels {red, green, blue} (the in_white used per channel), " +
        "before (Background patch mean) and after (composite patch mean, null if the re-measure failed) {r, g, b}, and " +
        "layer_id; tweak it later with set_adjustment type levels.",
      inputSchema: {
        doc: docArg,
        bbox: box.describe("Neutral grey/white patch in image pixels"),
        strength: z.number().gt(0).max(1).default(1).describe("Above 0 up to 1 (full neutralisation)"),
        keep_warmth: z.number().min(0).max(1).default(0).describe("Share of the red-blue gap to keep: 0 = fully neutral"),
        name: z.string().min(1).default("White balance").describe("Name for the Levels layer"),
      },
    },
    async (args) => {
      const { left, top, right, bottom } = args.bbox;
      if (!(left < right && top < bottom)) return toolError("bbox must have left < right and top < bottom");
      return forward(bridge, "white_balance")(args);
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
    "delete_layer",
    {
      description:
        "Delete one layer (adjustment, pixel, group with its contents, smart object) from doc (default the active document). " +
        "Requires confirm: true, or the tool refuses and does nothing. The Background layer is never deleted (PROTECTED_LAYER). " +
        "The active document is unchanged afterwards. One undoable history step; returns the deleted layer's id and name, " +
        "and the updated layer tree in doc.",
      inputSchema: {
        doc: docArg,
        layer: layerId,
        confirm: z.boolean().optional().describe("Must be true, or the tool refuses and does nothing"),
      },
    },
    async (args) => {
      if (args.confirm !== true) return toolError("Set confirm: true to delete_layer.");
      return forward(bridge, "delete_layer")(args);
    },
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
