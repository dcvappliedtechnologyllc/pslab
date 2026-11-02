# pslab

## What it is

pslab is a Photoshop UXP plugin plus a local MCP server, so Claude can edit Photoshop documents by command. The plugin runs inside Photoshop and connects to the server over a local WebSocket (`ws://localhost:9777`); the server exposes Photoshop actions as MCP tools to Claude Desktop and Claude Code.

Edits are non-destructive by default: adjustment layers, masks and pasted pixel layers, one undo step per tool call. A bundled skill, `interior-photo-edit`, encodes a workflow for room photos: lighting, glare, replacing an object from a reference shot, and Instagram export.

## Requirements

- Photoshop 2026 (27.0 or later). Light, Clarity and Color-and-vibrance adjustment layers need 27.10 or later.
- Node.js 24.
- macOS. `scripts/register-mcp.sh` writes `~/Library/Application Support/Claude/claude_desktop_config.json` and runs `claude mcp add`.
- The UXP Developer Tool (from Creative Cloud) to sideload the plugin.

## Install

1. In Creative Cloud, install the **UXP Developer Tool**.
2. In Photoshop, enable developer mode (Settings > Plugins > Enable Developer Mode) and restart Photoshop if asked.
3. In the UXP Developer Tool, choose **Add Plugin**, select `plugin/manifest.json`, then click **Load**. Open the panel in Photoshop (Plugins > pslab) and click Connect.
4. Build and register the server:
   ```
   npm install
   npm run build -w server
   scripts/register-mcp.sh
   ```
5. Restart Claude Desktop / Claude Code so it picks up the server.
6. Install the skill: `scripts/install-skill.sh` (symlinks `skills/interior-photo-edit` into `~/.claude/skills/`).

The plugin manifest asks for `localFileSystem: "fullAccess"` because `export` writes JPGs to the export folder and `open_document` reads files you name. The server binds `127.0.0.1` only and refuses connections that come from browser origins.

## Tools

All coordinates are image pixels. `doc` is a document id from `get_document`; omitted, the active document is used.

### See

| Tool | Purpose |
| --- | --- |
| `get_document` | Document summary (size, ppi, profile, layer tree with ids) and the list of open documents |
| `open_document` | Open an image file from an absolute path as a new document |

| `render_preview` | Downscaled JPEG of the document or a region; returns `scale` (image px per preview px) |
| `region_stats` | Mean RGB and luminance, histogram and clipped-pixel percentages for a box |

Note: a Light adjustment layer reports kind `light` (pslab reads Photoshop's brightness-mode flag; legacy Brightness/Contrast reports `brightnessContrast`), Clarity and dehaze layers report `clarity`, and Color and vibrance layers report `vibrance`.

### Edit

| Tool | Purpose |
| --- | --- |
| `add_adjustment` | Add an adjustment layer: `light`, `curves`, `hue_sat`, `exposure`, `brightness_contrast`, `color_vibrance`, `clarity_dehaze` |
| `add_pixel_layer` | Add an empty named pixel layer |
| `mask_from_polygon` | Replace a layer's mask with a feathered polygon (optionally inverted) |
| `mask_from_subject` | Add a mask from Select Subject or Object Selection inside a box |
| `paint_mask` | Paint white or black brush strokes onto a layer's mask |
| `set_layer` | Change opacity, blend mode, visibility, name, or invert the mask |

### Composite

| Tool | Purpose |
| --- | --- |
| `select_object` | Select an object (or the main subject) in a document |
| `copy_to` | Copy the selection or a layer into another document, scaled and positioned |
| `refine_edge` | Build a contracted, feathered mask from a layer's transparency |
| `match_tone` | Match a pasted layer's tone to a reference region with clipped Hue/Sat and Curves |
| `blur_layer` | Gaussian blur as a smart filter |

### Output

| Tool | Purpose |
| --- | --- |
| `crop` | Crop the document to a ratio (e.g. `4:5`) or a box; needs `confirm: true` |
| `export` | Write an sRGB JPEG (default long edge 1350 px) to the export root; needs `confirm: true` |
| `save` | Save the document as PSD or JPG; needs `confirm: true` |

Developer tool: `dev_events` returns recorded Photoshop events for discovering batchPlay descriptors.

## Safety

- `crop`, `export` and `save` do nothing unless called with `confirm: true`.
- Every tool call is one undo step in Photoshop.
- There is no flatten, delete-layer or close-document tool.
- `export` works on a temporary copy; the open document is untouched. It overwrites a file with the same name.
- Exports go to `~/Documents/pslab-exports/<shoot>/<filename>`, where `<shoot>` is the name of the source file's folder, used as the export subfolder. Set `PSLAB_EXPORT_ROOT` to change the root.

## Troubleshooting

- **Not connected**: open the pslab panel in Photoshop and click Connect.
- **Permission denied on the socket**: in `plugin/manifest.json` set `network.domains` to `"all"`, then reload the plugin in the UXP Developer Tool.
- **After every Photoshop restart**: reload the plugin in the UXP Developer Tool, then open the panel.
- **Tools missing in Claude**: re-run `scripts/register-mcp.sh` and restart Claude Desktop / Claude Code.
- **Several Claude apps at once**: every Claude app or session starts its own pslab server (Claude Desktop starts two). The first one owns port 9777 and talks to Photoshop; the others forward their tool calls to it, so every chat works. When the owner quits, one of the others takes over within about 5 s and the panel reconnects on its own within about 15 s. The server log says `bridge listening on 127.0.0.1:9777` for the owner and `following owner pid <n>` for the others; set `PSLAB_DEBUG=1` to also log mode changes and each forwarded call.
- **PORT_BUSY**: port 9777 is held by something that is not pslab. The error names the process; quit it, or set `PSLAB_PORT` (and the panel's Port field) to another port.
- **Can't find an export**: files are under `~/Documents/pslab-exports/<shoot>/` unless `PSLAB_EXPORT_ROOT` is set.

## Development

- `npm test` runs the server and plugin tests.
- `npm run build -w server` builds the server to `server/dist`.
- `scripts/dev-harness.mjs` is a development tool that runs the real server in-process and exposes tool calls over HTTP on `127.0.0.1:9778`. It is loopback-only with no authentication; do not expose it.
- Layout: `server/` (MCP server and WebSocket bridge), `plugin/` (UXP plugin), `skills/` (Claude skills), `scripts/` (install and register helpers), `docs/` (design, development log and research notes).

## Disclaimer

pslab is an unofficial project. It is not affiliated with or endorsed by Adobe or Anthropic. Photoshop and UXP are trademarks of Adobe. Use at your own risk.

## License

MIT. See `LICENSE`.
