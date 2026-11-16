import { z } from "zod";

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Text properties of a text layer (get_document only); any field may be null when unreadable. */
export interface TextInfo {
  content: string | null;
  font: string | null;
  style: string | null;
  size_pt: number | null;
  color: { r: number; g: number; b: number } | null;
  justification: string | null;
}

export interface LayerSummary {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  blend: string;
  clipped: boolean;
  hasMask: boolean;
  /** null when the layer has no mask (or the state could not be read). Optional: older plugins omit it. */
  maskEnabled?: boolean | null;
  /** Pixel bounds without effects; null when the layer is empty. Optional: older plugins omit it. */
  bounds?: Bounds | null;
  text?: TextInfo;
  children: LayerSummary[];
}

export interface DocSummary {
  id: number;
  name: string;
  width: number;
  height: number;
  ppi: number;
  profile: string;
  bits: number;
  activeLayerId: number | null;
  /** get_document only: "crop" | "transform" | "text" | "busy" | "unknown" while Photoshop is modal, else null. */
  modal?: string | null;
  layers: LayerSummary[];
}

const BoundsSchema = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });

const TextInfoSchema = z.object({
  content: z.string().nullable(),
  font: z.string().nullable(),
  style: z.string().nullable(),
  size_pt: z.number().nullable(),
  color: z.object({ r: z.number(), g: z.number(), b: z.number() }).nullable(),
  justification: z.string().nullable(),
});

export const LayerSummarySchema: z.ZodType<LayerSummary> = z.lazy(() =>
  z.object({
    id: z.number(),
    name: z.string(),
    kind: z.string(),
    visible: z.boolean(),
    opacity: z.number(),
    blend: z.string(),
    clipped: z.boolean(),
    hasMask: z.boolean(),
    maskEnabled: z.boolean().nullable().optional(),
    bounds: BoundsSchema.nullable().optional(),
    text: TextInfoSchema.optional(),
    children: z.array(LayerSummarySchema),
  }),
);

export const DocSummarySchema: z.ZodType<DocSummary> = z.object({
  id: z.number(),
  name: z.string(),
  width: z.number(),
  height: z.number(),
  ppi: z.number(),
  profile: z.string(),
  bits: z.number(),
  activeLayerId: z.number().nullable(),
  modal: z.string().nullable().optional(),
  layers: z.array(LayerSummarySchema),
});

export const HelloFrame = z.object({
  type: z.literal("hello"),
  plugin: z.literal("pslab"),
  version: z.string(),
  ps: z.string(),
});

export const RequestFrame = z.object({
  type: z.literal("request"),
  id: z.string(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()),
});

const OkResponse = z
  .object({
    type: z.literal("response"),
    id: z.string(),
    ok: z.literal(true),
    result: z.unknown(),
    doc: DocSummarySchema.nullable(),
  })
  .strict();

const ErrResponse = z
  .object({
    type: z.literal("response"),
    id: z.string(),
    ok: z.literal(false),
    error: z.object({ message: z.string(), code: z.string() }),
  })
  .strict();

export const ResponseFrame = z.discriminatedUnion("ok", [OkResponse, ErrResponse]);

export const PingFrame = z.object({ type: z.literal("ping") });
export const PongFrame = z.object({ type: z.literal("pong") });

export const Frame = z.union([HelloFrame, RequestFrame, ResponseFrame, PingFrame, PongFrame]);
export type Frame = z.infer<typeof Frame>;

export function parseFrame(text: string): Frame {
  return Frame.parse(JSON.parse(text));
}
