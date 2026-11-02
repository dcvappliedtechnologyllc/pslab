# pslab design: Photoshop × Claude plugin

Date: 2026-11-01. Status: implemented.

## Purpose

Claude edits Photoshop through exact, non-destructive commands instead of
screenshots and clicks. A UXP plugin inside Photoshop executes commands; a
local MCP server exposes them to Claude Desktop and Claude Code. Every
coordinate is in image pixels of the target document. Every document change is
one named, undoable history step.

The Nov 1 session edited six interior photos by driving the Photoshop UI. All
five failures came from the screen layer (zoom math, typed values in the wrong
field, modal dialogs out of reach, wrong menu item, strokes that drifted). This
plugin removes that layer.

## Decisions (from the brainstorm)

- Clean repo, `adb-mcp` used only as reference (MIT, no code copied).
- Single Node process: MCP server over stdio **and** WebSocket server on
  localhost. No proxy, no Python. UXP can only be a socket client.
- Registered in both Claude Desktop and Claude Code.
- Exports go to a fixed root per shoot: `~/Documents/pslab-exports/<shoot>/`,
  overridable with `PSLAB_EXPORT_ROOT`.
- Scope of the first build: phases 0 through 3 plus the skill.
- Previews are JPEG, not PNG: the UXP imaging API only encodes JPEG.
- Masks are painted by rasterizing strokes in the plugin and writing them with
  `imaging.putLayerMask`, not by driving the brush tool.

## Architecture

```
Claude (Desktop or Code)
   │ stdio (MCP)
   ▼
pslab server  (Node 24, TypeScript)  ── ws://localhost:9777 ──▶ ◀── UXP plugin (client)
   • @modelcontextprotocol/sdk, ws                                  inside Photoshop 27.10+
   • one tool = one request id                                      • executeAsModal + suspendHistory
   • 60 s per-request timeout                                       • batchPlay + DOM + imaging API
```

### Wire protocol

JSON text frames over one persistent WebSocket.

```
plugin → server   {"type":"hello","plugin":"pslab","version":"0.1.0","ps":"27.11.0"}
server → plugin   {"type":"request","id":"r-17","action":"add_adjustment","args":{...}}
plugin → server   {"type":"response","id":"r-17","ok":true,"result":{...},"doc":{...}}
plugin → server   {"type":"response","id":"r-17","ok":false,"error":{"message":"...","code":"NO_DOCUMENT"}}
either            {"type":"ping"} / {"type":"pong"}
```

- `doc` on every successful response: `{id, name, width, height, ppi, profile,
  bits, activeLayerId, layers:[{id,name,kind,visible,opacity,blend,clipped,hasMask,children}]}`.
- Server rejects a tool call with a clear message when no plugin is connected
  ("Photoshop plugin not connected. Open Plugins > pslab in Photoshop.").
- Plugin reconnects with backoff (1 s → 30 s) and re-sends `hello`.
- Request ids are server-generated; the server keeps a map id → promise.
- Large payloads (previews) are base64 inside the JSON frame; the server sets
  `maxPayload` to 64 MB.

### Execution contract (plugin side)

Every mutating action runs through one wrapper:

```js
runStep(name, docId, async (ctx) => { ... })
```

1. `core.executeAsModal(fn, {commandName: name, interactive: false, timeOut: 30})`.
2. Inside, `hostControl.suspendHistory({documentID, name})`.
3. On success `resumeHistory(id, true)`; on any error `resumeHistory(id, false)`
   so the document is rolled back, then the error is returned as a value and
   rethrown outside the modal scope (errors thrown inside lose their type).
4. Every batchPlay result array is checked for `{_obj:"error"}`; one hit fails
   the step.
5. Read-only actions (`get_document`, `render_preview`, `region_stats`) also
   use `executeAsModal` (the imaging API requires it) but never suspend history.
6. Dialogs: every descriptor carries `_options:{dialogOptions:"dontDisplay"}`.

History names follow the pattern `Claude: <tool>, <key values>`, e.g.
`Claude: Light, Exposure +0.6`, `Claude: paint_mask, 3 strokes`.

### Layer targeting

Tools take a `layer` argument that is the integer layer id from `doc.layers`.
The plugin resolves it, selects it exclusively (`select` by `_id`), and only
then runs descriptors with an `ordinal/targetEnum` target. Layers are compared
by id, never by object identity.

## Tool surface

All coordinates are image pixels. `bbox` is `{left, top, right, bottom}`.
`doc` arguments are document ids from `get_document`; when omitted the active
document is used.

### See

| Tool | Args | Returns |
| --- | --- | --- |
| `get_document` | `doc?` | document summary (above) plus `open_docs:[{id,name}]` |
| `render_preview` | `doc?`, `region?` (bbox), `max_px` (default 1500) | MCP image (JPEG) and text: `{scale: image_px_per_preview_px, preview:{w,h}, region}`. Scale is exact: `region_width / preview_width`. |
| `region_stats` | `doc?`, `bbox`, `layer?` | `{mean:{r,g,b,l}, histogram_l:[32 bins], clipped_high_pct, clipped_low_pct, px_sampled}` computed from `getPixels` at most 512 px wide |

### Edit

| Tool | Args | Effect |
| --- | --- | --- |
| `add_adjustment` | `type` (`light`, `curves`, `hue_sat`, `color_vibrance`, `clarity_dehaze`, `exposure`, `brightness_contrast`), `params`, `clip_to?` (layer id), `name?`, `above?` (layer id) | new adjustment layer, returns its id |
| `mask_from_polygon` | `layer`, `points[]` (`{x,y}`), `feather_px`, `invert?` | layer mask written from the polygon |
| `mask_from_subject` | `layer`, `bbox`, `mode` (`subject`/`object`) | mask from Select Subject or Object Selection inside bbox |
| `paint_mask` | `layer`, `strokes[]` (`{points[], size_px, hardness 0..1, opacity 0..1}`), `color` (`white`/`black`) | strokes rasterized and composited onto the existing mask (a mask is created, filled white, if none) |
| `set_layer` | `layer`, `opacity?`, `blend?`, `visible?`, `name?`, `mask_invert?` | properties updated |

`params` per adjustment type (all optional, defaults 0):

- `light`: `exposure` (-5..5), `contrast`, `highlights`, `shadows`, `whites`, `blacks` (each -100..100)
- `curves`: `points` per channel, e.g. `{rgb:[[0,0],[128,121],[255,255]]}`
- `hue_sat`: `hue`, `saturation`, `lightness`
- `color_vibrance`: `vibrance`, `saturation`, `temperature`, `tint`
- `clarity_dehaze`: `clarity`, `dehaze`
- `exposure`: `exposure`, `offset`, `gamma`
- `brightness_contrast`: `brightness`, `contrast`

### Composite

| Tool | Args | Effect |
| --- | --- | --- |
| `select_object` | `doc?`, `bbox`, `mode` (`object`/`subject`) | selection made; returns `{bounds}` |
| `copy_to` | `src_doc`, `src_layer?`, `use_selection` (default true), `dst_doc`, `transform:{scale_pct, cx, cy}`, `name?` | new pixel layer in dst placed so its center lands at (cx, cy) after scaling; profile converted to dst |
| `refine_edge` | `layer`, `contract_px`, `feather_px`, `decontaminate?` | layer mask built from the layer's transparency, contracted and feathered; `decontaminate` runs Defringe on a duplicate |
| `match_tone` | `layer`, `reference_bbox` | clipped Hue/Sat + Curves computed from stats of the layer vs the reference region; returns the values used |
| `blur_layer` | `layer`, `radius_px` | Gaussian blur as a smart filter (layer converted to smart object first) |

### Output

| Tool | Args | Effect |
| --- | --- | --- |
| `crop` | `doc?`, `ratio?` (`"4:5"`) or `bbox`, `confirm` | crop applied |
| `export` | `doc?`, `shoot`, `filename`, `long_edge_px` (default 1350), `quality` (1..12, default 10), `confirm` | duplicate doc → convert to sRGB → resize → save JPEG to `<PSLAB_EXPORT_ROOT>/<shoot>/<filename>` → close copy |
| `save` | `doc?`, `path?`, `format` (`psd`/`jpg`), `confirm` | saves |

`confirm` must be literally `true` or the tool returns an error without
touching anything. Flatten, delete layer and close document are not exposed.

## Open technical questions and their fallbacks

| Question | How it is settled | Fallback |
| --- | --- | --- |
| Light / Clarity & dehaze / Color & vibrance descriptors | Record with Plugins > Development > Record Action Commands in PS 27.10+ (spike at the start of phase 2) | `light` = group "Light" holding an Exposure layer (exposure) and a Curves layer (contrast, highlights, shadows approximated); `clarity_dehaze` and `color_vibrance` return `NOT_SUPPORTED` |
| `ws://localhost` under manifest v5 on macOS 26 | Try `["ws://localhost:9777","ws://localhost","http://localhost"]` first | `"network":{"domains":"all"}` |
| Cross-profile `layer.duplicate` to another document may show a paste-profile dialog | Test in phase 3 | duplicate the source document, `convertProfile` to the destination profile, then duplicate the layer |
| `group:true` in `make adjustmentLayer` | Record | `groupEvent` after creation |
| Defringe / gaussianBlur key names | Record | DOM `layer.applyGaussianBlur`; skip defringe, rely on contract+feather |

## Repo layout

```
pslab/
  README.md  LICENSE (MIT)  package.json (workspaces)
  server/            TypeScript MCP + WebSocket server
    src/index.ts     entry: stdio MCP, starts ws server
    src/bridge.ts    PluginBridge: connection, request ids, timeouts
    src/tools/*.ts   one file per tool group (see, edit, composite, output)
    test/            vitest; FakePlugin over a real ws server
  plugin/            UXP plugin (plain JS, CommonJS, no bundler)
    manifest.json  index.html  main.js
    lib/step.js      runStep (modal + history)
    lib/descriptors.js  batchPlay builders (pure)
    lib/raster.js    stroke rasterizer, polygon fill (pure)
    lib/stats.js     region statistics (pure)
    lib/actions/*.js one file per tool group
    test/            node:test over the pure modules
  skills/interior-photo-edit/SKILL.md
  scripts/register-mcp.sh   writes both Claude configs
  docs/
```

Pure modules (`descriptors`, `raster`, `stats`) have no Photoshop imports so
Node can test them. Action modules receive `ps` (the `photoshop` module) by
injection so they can be tested with a stub.

## Testing

- **Server:** vitest. `FakePlugin` connects to the real ws server and answers
  scripted responses. Tests cover: no plugin → clear error, request/response
  correlation under concurrency, timeout, reconnect, confirm-flag enforcement,
  export path construction.
- **Plugin pure modules:** `node --test`. Stroke rasterizer (falloff, hardness,
  opacity compositing, clipping to canvas), polygon scanline fill with feather,
  descriptor builders (snapshot each recorded descriptor), stats (clipping
  percentages on synthetic buffers).
- **Live done-when tests** (manual, in Photoshop, per the original project brief):
  - Phase 0: Claude lists open docs and adds an empty layer.
  - Phase 1: Claude reports the photo A shelf bbox in image px within 5 px.
  - Phase 2: the photo D glare fix from one prompt, one undo per step.
  - Phase 3: the photo B object lands in photo C in one pass, no grey fringe.
  - Phase 4: a folder of 6 room photos exported at 1080×1350 sRGB.

## Install and registration

1. UXP Developer Tool from the Creative Cloud app (the user installs; needs admin
   consent on first launch). Developer mode on in Photoshop preferences.
2. UDT: Add Plugin → `plugin/manifest.json` → Load. Reload after each
   Photoshop restart until a `.ccx` is packaged (phase 5).
3. `scripts/register-mcp.sh` adds `pslab` to
   `~/Library/Application Support/Claude/claude_desktop_config.json` and runs
   `claude mcp add --scope user pslab -- node <repo>/server/dist/index.js`.

## Non-goals (this build)

In-Photoshop chat panel, `.ccx` packaging, batch folder driver (phase 4 and 5
of the original brief), anything that shows a dialog.
