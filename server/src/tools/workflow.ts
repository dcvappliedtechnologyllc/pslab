import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult } from "./common.js";

// An image tool answers with the JPEG as an image block and everything else
// (plus the document summary) as JSON text, like render_preview.
function imageReply(bridge: PluginBridge, action: string) {
  return async (args: unknown) => {
    try {
      const { result, doc } = await bridge.call(action, args);
      const { jpeg_base64, ...meta } = (result ?? {}) as { jpeg_base64?: string } & Record<string, unknown>;
      return {
        content: [
          { type: "image" as const, data: String(jpeg_base64 ?? ""), mimeType: "image/jpeg" },
          { type: "text" as const, text: JSON.stringify({ ...meta, doc }) },
        ],
      };
    } catch (e) {
      return toolError(e);
    }
  };
}

function forward(bridge: PluginBridge, action: string) {
  return async (args: unknown) => {
    try {
      return toolResult(await bridge.call(action, args));
    } catch (e) {
      return toolError(e);
    }
  };
}

export function registerWorkflowTools(server: McpServer, bridge: PluginBridge): void {
  // Only dst changes (the DOM duplicate needs no source activation), so it is
  // one undo in dst and none in src.
  server.registerTool(
    "copy_layers_to",
    {
      description:
        "Copy an adjustment stack (adjustment or pixel layers, with their masks) from src_doc onto the top of dst_doc, " +
        "keeping the source stack order, so a look built on one shot carries to the next. layers are layer ids in src_doc " +
        "(any order; the Background cannot be copied). Returns layer_ids (the new ids in dst_doc, in the same order as " +
        "layers) and names. Masks keep their pixel positions, so check them on a shot framed differently. dst_doc is left " +
        "as the active document. One undoable history step in dst_doc; src_doc is not changed.",
      inputSchema: {
        src_doc: z.number().int().describe("Source document id"),
        dst_doc: z.number().int().describe("Destination document id (must differ from src_doc)"),
        layers: z.array(z.number().int()).min(1).describe("Layer ids in src_doc to copy"),
      },
    },
    forward(bridge, "copy_layers_to"),
  );

  server.registerTool(
    "open_folder",
    {
      description:
        "Open every image in a folder (absolute path) as documents, in file-name order (numbers sort naturally: " +
        "IMG_2 before IMG_10). pattern is an optional case-insensitive file-name glob with * and ? (e.g. \"IMG_*.HEIC\"); " +
        "by default JPG, JPEG, HEIC, HEIF, PNG, TIF, TIFF and PSD files are opened. Subfolders are skipped. At most 50 files " +
        "(TOO_MANY_FILES otherwise: narrow the pattern). If one file fails, the ones opened before it stay open and the " +
        "error OPEN_FAILED lists them. Returns docs [{id, name, path}], count, and the open documents in open_docs; the last " +
        "file opened is active. Creates no history state.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the folder"),
        pattern: z
          .string()
          .min(1)
          .regex(/^[^/]*$/, "pattern must not contain /")
          .optional()
          .describe("File-name glob with * and ?, case-insensitive; default: common image types"),
      },
    },
    async (args) => {
      if (!args.path.startsWith("/")) return toolError(new Error("INVALID_ARGS: path must be absolute"));
      return forward(bridge, "open_folder")(args);
    },
  );

  // Runs in a scratch history step that is always rolled back: no history state, no net change.
  server.registerTool(
    "compare_preview",
    {
      description:
        "One side-by-side JPEG to judge an edit: LEFT is \"before\" (the document with the layers in layer_ids_off hidden), " +
        "RIGHT is \"after\" (the document as it is now), with a grey 8 px gap. max_px is the width of the whole image, so each " +
        "half is under max_px / 2 wide. Returns half {w, h} and scale = image pixels per preview pixel within each half. " +
        "The layers are hidden only while reading pixels: the document is left unchanged and no history state is added.",
      inputSchema: {
        doc: z.number().int().optional().describe("Document id; defaults to the active document"),
        layer_ids_off: z.array(z.number().int()).min(1).describe("Layer ids to hide for the \"before\" half (e.g. your new layers)"),
        max_px: z.number().int().min(200).max(4000).default(1500).describe("Width of the whole side-by-side image in pixels"),
      },
    },
    imageReply(bridge, "compare_preview"),
  );

  server.registerTool(
    "contact_sheet",
    {
      description:
        "One JPEG tiling the current composites of several open documents (1 to 24), left to right, top to bottom in the " +
        "order of docs, each centered in a square cell on mid-grey with 8 px gaps, to compare a set of shots at a glance. " +
        "cols defaults to ceil(sqrt(n)); max_px is the long edge of the whole sheet. Returns sheet {w, h, cols, rows, cell} " +
        "and cells [{doc, name, x, y, w, h}] (where each document landed, in sheet pixels). Read-only: no history state.",
      inputSchema: {
        docs: z.array(z.number().int()).min(1).max(24).describe("Open document ids, in sheet order"),
        cols: z.number().int().min(1).max(8).optional().describe("Columns, 1..8; default ceil(sqrt(number of docs))"),
        max_px: z.number().int().min(400).max(4000).default(1500).describe("Long edge of the whole sheet in pixels"),
      },
    },
    imageReply(bridge, "contact_sheet"),
  );
}
