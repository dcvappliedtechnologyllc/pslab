import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PluginBridge } from "../bridge.js";
import { toolError, toolResult } from "./common.js";

const UNSAFE = ["/", "\\", ".."];

/** <root>/<shoot>/<filename>; shoot and filename must be single safe path parts, filename a .jpg with a stem not starting with a dot. */
export function exportPath(root: string, shoot: string, filename: string): string {
  const unsafe = (s: string) => UNSAFE.some((u) => s.includes(u));
  const stem = filename.slice(0, -4);
  if (
    !shoot ||
    shoot === "." ||
    unsafe(shoot) ||
    unsafe(filename) ||
    !filename.toLowerCase().endsWith(".jpg") ||
    stem === "" ||
    stem.startsWith(".")
  ) {
    throw new Error("invalid shoot or filename");
  }
  return path.join(root, shoot, filename);
}

function exportRoot(): string {
  return process.env.PSLAB_EXPORT_ROOT || path.join(os.homedir(), "Documents", "pslab-exports");
}

function refuse(verb: string) {
  return { isError: true, content: [{ type: "text" as const, text: `Set confirm: true to ${verb}.` }] };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function call(bridge: PluginBridge, action: string, args: unknown) {
  try {
    return toolResult(await bridge.call(action, args));
  } catch (e) {
    return toolError(e);
  }
}

const docArg = z.number().int().optional().describe("Document id; defaults to the active document");
const confirmArg = z.boolean().optional().describe("Must be true, or the tool refuses and does nothing");

export function registerOutputTools(server: McpServer, bridge: PluginBridge): void {
  server.registerTool(
    "crop",
    {
      description:
        "Crop the document itself (destructive: pixels outside the box are discarded; undo is the only way back). " +
        "Requires confirm: true. Give exactly one of ratio (e.g. \"4:5\", the Instagram portrait crop: " +
        "the largest centered box of that aspect) or bbox in image pixels. One undoable history step; returns the bbox used.",
      inputSchema: {
        doc: docArg,
        ratio: z.string().regex(/^\d+:\d+$/).optional().describe("Aspect ratio W:H, e.g. 4:5"),
        bbox: z
          .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
          .optional()
          .describe("Crop box in image pixels"),
        confirm: confirmArg,
      },
    },
    async ({ confirm, ...args }) => {
      if (confirm !== true) return refuse("crop");
      if ((args.ratio === undefined) === (args.bbox === undefined)) return toolError("Give exactly one of ratio or bbox.");
      return call(bridge, "crop", args);
    },
  );

  server.registerTool(
    "export",
    {
      description:
        "Write an sRGB JPEG of the document to disk, overwriting any file with the same name. " +
        "Requires confirm: true. The document itself is untouched (a temporary copy is merged, converted, resized and closed). " +
        `Files land in <root>/<shoot>/<filename>, where root is ${exportRoot()} ` +
        "(PSLAB_EXPORT_ROOT, default ~/Documents/pslab-exports); shoot is one folder name and filename must end in .jpg. " +
        "long_edge_px sets the long edge (never upscales); defaults suit Instagram: crop 4:5 first, then " +
        "long_edge_px 1350 gives 1080x1350. Returns the path and final width/height.",
      inputSchema: {
        doc: docArg,
        shoot: z.string().describe("Folder for this shoot, a single name (no / or ..)"),
        filename: z.string().describe("File name ending in .jpg"),
        long_edge_px: z.number().int().min(256).max(8000).default(1350).describe("Long edge in pixels (256..8000)"),
        quality: z.number().int().min(1).max(12).default(10).describe("JPEG quality 1..12"),
        confirm: confirmArg,
      },
    },
    async ({ confirm, shoot, filename, ...rest }) => {
      if (confirm !== true) return refuse("export");
      let target: string;
      try {
        target = exportPath(exportRoot(), shoot, filename);
      } catch (e) {
        return toolError(message(e));
      }
      const { doc, long_edge_px, quality } = rest;
      return call(bridge, "export", { ...(doc !== undefined ? { doc } : {}), path: target, long_edge_px, quality });
    },
  );

  server.registerTool(
    "save",
    {
      description:
        "Save the document (overwrites its file on disk; not undoable). Requires confirm: true. " +
        "Without path it saves in place (doc.save). With path (absolute, ending in .psd or .jpg to match format) " +
        "it saves to that file as PSD (layers kept; the document then refers to that file) or as a maximum-quality " +
        "JPEG copy (the document keeps referring to its own file).",
      inputSchema: {
        doc: docArg,
        path: z.string().optional().describe("Absolute file path ending in .psd or .jpg"),
        format: z.enum(["psd", "jpg"]),
        confirm: confirmArg,
      },
    },
    async ({ confirm, ...args }) => {
      if (confirm !== true) return refuse("save");
      if (args.path !== undefined) {
        if (!path.isAbsolute(args.path) || !args.path.toLowerCase().endsWith(`.${args.format}`)) {
          return toolError(`path must be absolute and end in .${args.format}`);
        }
      }
      return call(bridge, "save", args);
    },
  );
}
