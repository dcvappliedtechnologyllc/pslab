import { z } from "zod";

export interface LayerSummary {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  blend: string;
  clipped: boolean;
  hasMask: boolean;
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
  layers: LayerSummary[];
}

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
