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

const BLENDS = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color_burn", "linear_burn", "color_dodge", "linear_dodge", "soft_light", "hard_light",
] as const;

/** Drop shadow settings; every field optional (add_layer_style fills defaults, set_layer_style keeps current values). */
const shadowParams = z
  .object({
    color: color.optional().describe("Shadow colour r/g/b 0..255; add default black"),
    opacity: z.number().min(0).max(100).optional().describe("Opacity percent 0..100; add default 35"),
    angle: z.number().min(-180).max(180).optional().describe("Light angle in degrees (Photoshop's dial; 120 = light from the upper left, shadow down-right); add default 120"),
    distance_px: z.number().min(0).max(30000).optional().describe("Shadow offset in pixels; add default 6"),
    spread_pct: z.number().min(0).max(100).optional().describe("Spread percent 0..100 (the dialog's Spread); add default 0"),
    size_px: z.number().min(0).max(250).optional().describe("Blur size in pixels 0..250; add default 10"),
    blend: z.enum(BLENDS).optional().describe("Blend mode; add default multiply"),
  })
  .strict();

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
        "Any active selection is cleared. Returns layer_id, kind, vector (true = shape layer, false = pixel layer) " +
        "and bounds. One undoable history step.",
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

  server.registerTool(
    "add_layer_style",
    {
      annotations: hints.set,
      description:
        "Add a layer style to a layer in doc (Layer > Layer Style). style drop_shadow with params: color {r,g,b}, " +
        "opacity (default 35), angle (default 120; Use Global Light is off, so each layer keeps its own angle), " +
        "distance_px (default 6), spread_pct (default 0), size_px (default 10), blend (default multiply). The layer's " +
        "other effects (stroke, glow) are kept; an existing drop shadow is replaced, so the same call gives the same " +
        "result. The effect scales with the document resolution like Photoshop's own dialog. Works on text, shape and " +
        "pixel layers; the Background is refused (PROTECTED_LAYER). Bounds in get_document ignore effects. Returns " +
        "layer_id, style and applied (the full settings used). One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId.describe("The layer to style"),
        style: z.enum(["drop_shadow"]),
        params: shadowParams.default({}).describe("Style settings; omitted ones take the defaults"),
      },
    },
    async (args) => call(bridge, "add_layer_style", args),
  );

  server.registerTool(
    "clear_layer_style",
    {
      annotations: hints.set,
      description:
        "Remove every layer style (drop shadow, stroke, glow and any other effect) from a layer in doc " +
        "(Layer > Layer Style > Clear Layer Style). Pixels and the layer itself are untouched, and it is undoable. " +
        "A layer without effects is left alone (cleared: false, no history state). Returns layer_id, cleared and " +
        "removed (the effect names that were on the layer). One undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId.describe("The layer to clear"),
      },
    },
    async (args) => call(bridge, "clear_layer_style", args),
  );

  server.registerTool(
    "set_layer_style",
    {
      annotations: hints.set,
      description:
        "Change a layer style that add_layer_style (or the user) put on a layer in doc, in place. style drop_shadow: " +
        "params holds only the settings to change (color, opacity, angle, distance_px, spread_pct, size_px, blend); " +
        "the rest keep their current values. enabled: false hides the shadow and true shows it again, without " +
        "changing its settings. A shadow that follows Use Global Light keeps it unless angle is given (then it gets " +
        "that angle of its own). A stack of several drop shadows is collapsed to one (the first, changed). The " +
        "layer's other effects are kept. NO_STYLE when the layer has no drop shadow (use " +
        "add_layer_style). Returns layer_id, style, applied (the full settings now in effect) and enabled. One " +
        "undoable history step.",
      inputSchema: {
        doc: docArg,
        layer: layerId.describe("The layer whose style changes"),
        style: z.enum(["drop_shadow"]),
        params: shadowParams.default({}).describe("Only the settings to change"),
        enabled: z.boolean().optional().describe("false hides the effect, true shows it"),
      },
    },
    async (args) => {
      const changes = Object.values(args.params ?? {}).filter(given).length;
      if (changes === 0 && !given(args.enabled)) return toolError("Give params to change or enabled.");
      return call(bridge, "set_layer_style", args);
    },
  );
}
