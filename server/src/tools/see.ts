import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult, hints } from "./common.js";
import { DocSummarySchema } from "../protocol.js";

const box = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });

type PreviewResult = {
  jpeg_base64: string;
  preview: { w: number; h: number };
  region: { left: number; top: number; right: number; bottom: number };
  scale: number;
};

export function registerSeeTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "get_document",
    {
      annotations: hints.read,
      description:
        "Document summary (size, ppi, profile, bits, layer tree with ids) in doc, plus the list of open documents in " +
        "result.open_docs. Pass doc to target a document other than the active one. All coordinates everywhere are image pixels.",
      inputSchema: { doc: z.number().int().optional().describe("Document id; defaults to the active document") },
    },
    async (args) => {
      try {
        // The plugin returns the requested document's summary plus open_docs;
        // the summary goes in doc (once), open_docs stays in result.
        const r = await bridge.call("get_document", args);
        const { open_docs, ...rest } = (r.result ?? {}) as Record<string, unknown>;
        const summary = DocSummarySchema.safeParse(rest);
        return toolResult({ result: { open_docs: open_docs ?? [] }, doc: summary.success ? summary.data : r.doc });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "render_preview",
    {
      annotations: hints.read,
      description:
        "Downscaled JPEG preview of the document (or a region). Returns scale = image pixels per preview pixel; multiply preview coordinates by scale to get image pixels. Default long edge 1500 px; request a region at full resolution only for edge work.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        region: box.optional().describe("Region in image pixels; defaults to the whole canvas"),
        max_px: z.number().int().min(200).max(4000).default(1500).describe("Long edge of the preview in pixels"),
      },
    },
    async (args) => {
      try {
        const { result, doc } = await bridge.call("render_preview", args);
        const r = result as PreviewResult;
        return {
          content: [
            { type: "image" as const, data: r.jpeg_base64, mimeType: "image/jpeg" },
            {
              type: "text" as const,
              text: JSON.stringify({ scale: r.scale, preview: r.preview, region: r.region, doc }),
            },
          ],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "open_document",
    {
      annotations: hints.open,
      description:
        "Open an image file from disk as a new Photoshop document (absolute path; JPG, HEIC, PNG, PSD, TIFF). " +
        "Returns the new document's summary in doc and the open documents in result.open_docs. The new document becomes active.",
      inputSchema: { path: z.string().min(1).describe("Absolute path to the file") },
    },
    async (args) => {
      try {
        if (!args.path.startsWith("/")) return toolError(new Error("INVALID_ARGS: path must be absolute"));
        const r = await bridge.call("open_document", args);
        const { open_docs, ...rest } = (r.result ?? {}) as Record<string, unknown>;
        const parsed = DocSummarySchema.safeParse(rest);
        return toolResult({ result: { open_docs }, doc: parsed.success ? parsed.data : r.doc });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "region_stats",
    {
      annotations: hints.read,
      description:
        "Mean RGB and luminance, 32-bin luminance histogram, and percentage of clipped highlights (L>=250) and shadows (L<=5) for a bbox in image pixels, on the composite or one layer.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        bbox: box.describe("Box in image pixels"),
        layer: z.number().int().optional().describe("Layer id; omit for the composite"),
      },
    },
    async (args) => {
      try {
        return toolResult(await bridge.call("region_stats", args));
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
