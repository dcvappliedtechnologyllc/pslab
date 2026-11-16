# pslab design: Photoshop × Claude plugin

Date: 2026-11-01. Status: implemented. Updated for v0.3 on 2026-11-17.

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
  bits, activeLayerId, modal?, layers:[{id, name, kind, visible, opacity, blend,
  clipped, hasMask, maskEnabled, bounds, text?, children}]}`.
  - `bounds` is `{left, top, right, bottom}` in pixels without effects (a drop
    shadow does not change it); null for an empty layer or an adjustment
    without a mask.
  - `maskEnabled` is null without a mask; false means the mask exists but is
    switched off.
  - `text` (`get_document` only, text layers only): `{content, font, style,
    size_pt, color:{r,g,b}, justification}`; any field is null when unreadable.
  - `modal` (`get_document` only): null normally; `"crop"`, `"transform"`,
    `"text"`, `"dialog"`, `"busy"` (another plugin) or `"unknown"` while
    Photoshop is modal. Other tools then answer `MODAL_BUSY`.
  - The new fields are optional in the server schema, so an older plugin
    still validates.
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
`Claude: Light, Exposure +0.6`, `Claude: paint_mask, 3 strokes`,
`Claude: move_layer, 3 layers 0,100`, `Claude: delete_layer, 7 layers`.

History-step rules:

- One call is at most one history state, also for batches (`delete_layer
  layers`, `move_layer`, `align_layers`).
- Arguments are validated before the step opens, so a refused call leaves no
  state.
- A call that would change nothing makes no state (`reorder_layer` already in
  place, `move_layer` with nothing to move, `align_layers` already aligned,
  `transform_layer` with nothing to change, `clear_layer_style` on a layer
  without effects).
- Temporary changes made to compute a result (the visibility toggles of
  `content_aware_fill sample`, the hidden layers of `compare_preview`, the
  redraw after a mask write) happen inside the same suspended step and are
  undone before it closes.
- No step: the read tools, `select_layer`, `open_document`, `open_folder`
  and the file writers (`export`, `save`, `save_psd`).

### Tool hints

Every tool declares all four MCP annotations (`server/src/tools/common.ts`),
so hosts can warn before destructive calls. `openWorldHint` is always false.

| Profile | read-only | destructive | idempotent | Tools |
| --- | --- | --- | --- | --- |
| `read` | yes | no | yes | get_document, render_preview, region_stats, preview_mask, compare_preview, contact_sheet |
| `open` | no | no | yes | open_document, open_folder |
| `add` | no | no | no | layer-, mask- or selection-creating tools (add_adjustment, add_shape, stamp_visible, copy_to, ...) |
| `set` | no | no | yes | set_adjustment, set_layer, select_layer, reorder_layer, align_layers, add/set/clear_layer_style, set_blur, dev_events |
| `edit` | no | no | no | move_layer, transform_layer (relative: repeating moves or scales again) |
| `destroy` | no | yes | no | crop, delete_layer |
| `write` | no | yes | yes | export, save, save_psd |

The destructive set is pinned to crop, delete_layer, export, save and
save_psd, and a test keeps it that way.

### Layer targeting

Tools take a `layer` argument that is the integer layer id from `doc.layers`.
The plugin resolves it, selects it exclusively (`select` by `_id`), and only
then runs descriptors with an `ordinal/targetEnum` target. Layers are compared
by id, never by object identity.

## Tool surface

All coordinates are image pixels. `bbox` is `{left, top, right, bottom}`.
`doc` arguments are document ids from `get_document`; when omitted the active
document is used. 45 tools, grouped as in `server/src/tools/*.ts`. The tool
descriptions in those files are the source of truth for details.

### See (`see.ts`)

| Tool | Args | Returns |
| --- | --- | --- |
| `get_document` | `doc?` | document summary (above, with `text` and `modal`) plus `open_docs:[{id,name}]` |
| `open_document` | `path` (absolute) | the new document's summary; it becomes active |
| `render_preview` | `doc?`, `region?` (bbox), `max_px` (default 1500) | MCP image (JPEG) and text: `{scale: image_px_per_preview_px, preview:{w,h}, region, warning?}`. Exact integer downscales are avoided, so the long edge can be one pixel under `max_px`; `warning` means Photoshop returned another area and `region`/`scale` describe what came back. |
| `region_stats` | `doc?`, `bbox`, `layer?` | `{mean:{r,g,b,l}, histogram_l:[32 bins], clipped_high_pct, clipped_low_pct, px_sampled}` from `getPixels` at most 512 px wide |

### Edit (`edit.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `add_adjustment` | `doc?`, `type` (`light`, `curves`, `hue_sat`, `color_vibrance`, `clarity_dehaze`, `exposure`, `brightness_contrast`, `levels`), `params`, `clip_to?`, `name?`, `above?` | new adjustment layer; any active selection is cleared first; returns its id |
| `set_adjustment` | `doc?`, `layer`, `type`, `params` | changes an adjustment layer's values in place |
| `white_balance` | `doc?`, `bbox`, `strength` (default 1), `keep_warmth` (default 0), `name?` | per-channel Levels layer directly above the Background; returns before/after means |
| `add_pixel_layer` | `doc?`, `name`, `above?` | empty pixel layer |
| `mask_from_polygon` | `doc?`, `layer`, `points[]`, `feather_px`, `invert?` | layer mask written from the polygon |
| `mask_from_subject` | `doc?`, `layer`, `bbox`, `mode` (`subject`/`object`) | mask from Select Subject or Object Selection inside bbox |
| `paint_mask` | `doc?`, `layer`, `strokes[]` (`{points[], size_px, hardness 0..1, opacity 0..1}`), `color` (`white`/`black`) | strokes rasterized and composited onto the existing mask (a white mask is created if none) |
| `delete_layer` | `doc?`, `layer` or `layers[]` (1..100), `confirm` | deletes; `layers` is one history step; never the Background |
| `set_layer` | `doc?`, `layer`, `opacity?`, `blend?`, `visible?`, `name?`, `mask_invert?` | properties updated |

`params` per adjustment type (all optional, defaults 0):

- `light`: `exposure` (-5..5), `contrast`, `highlights`, `shadows`, `whites`, `blacks` (each -100..100)
- `curves`: `points` per channel, e.g. `{rgb:[[0,0],[128,121],[255,255]]}`
- `hue_sat`: `hue`, `saturation`, `lightness`
- `color_vibrance`: `vibrance`, `saturation`, `temperature`, `tint`
- `clarity_dehaze`: `clarity`, `dehaze`
- `exposure`: `exposure`, `offset`, `gamma`
- `brightness_contrast`: `brightness`, `contrast`
- `levels`: per channel `{in_black, in_white, gamma, out_black, out_white}`

Every mask write (polygon, paint and the mask tools) redraws the layer and
re-targets the RGB channel inside the same step (bug 1, see the development
log).

### Masks (`masks.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `mask_from_luminance` | `doc?`, `layer`, `min_l`, `max_l` (default 255), `feather_px?`, `invert?` | mask from a luminance range of the composite; returns `coverage_pct` |
| `mask_gradient` | `doc?`, `layer`, `kind` (`linear`/`radial`), `from`, `to?` (linear), `radius_px?` (radial), `invert?` | gradient mask |
| `mask_from_color` | `doc?`, `layer`, `sample` or `rgb`, `fuzziness` (default 40), `feather_px?`, `invert?` | colour-range mask; returns `coverage_pct`, `sampled_rgb` |
| `preview_mask` | `doc?`, `layer`, `max_px` (default 1000) | read-only JPEG of the mask with `scale`; `has_mask:false` without one |

### Composite (`composite.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `select_object` | `doc?`, `bbox`, `mode` (`object`/`subject`) | selection made; returns `{bounds}` |
| `copy_to` | `src_doc`, `src_layer?`, `use_selection` (default true), `dst_doc`, `transform:{scale_pct, cx, cy}`, `name?`, `above?` | new pixel layer in dst placed so its center lands at (cx, cy) after scaling; profile converted to dst; above the active layer or directly above `above` |
| `refine_edge` | `doc?`, `layer`, `contract_px`, `feather_px`, `decontaminate?` | layer mask built from the layer's transparency, contracted and feathered; `decontaminate` runs Defringe on a duplicate |
| `match_tone` | `doc?`, `layer`, `reference_bbox` | clipped Hue/Sat + Curves computed from stats of the layer vs the reference region; returns the values used |
| `blur_layer` | `doc?`, `layer`, `radius_px` | Gaussian blur as a smart filter (layer converted to smart object first) |
| `set_blur` | `doc?`, `layer`, `radius_px`, `index?` | edits an existing Gaussian Blur smart filter's radius in place; `index` (1 = bottom) is required when there are several; `NO_SMART_FILTER` without one |

### Geometry and cleanup (`geometry.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `straighten` | `doc?`, `angle_deg` or `auto`, `vertical?` | rotated "Straightened" smart-object copy of the Background |
| `content_aware_fill` | `doc?`, `bbox` or `polygon`, `name`, `above?`, `sample` (`visible` default, `below`, `layers`), `sample_layers?` | patch on a new layer; `sample` limits what the stamp is made from; a region covering the canvas is refused |
| `clone_from` | `doc?`, `src_bbox`, `dst`, `name`, `feather_px?`, `above?` | copy of a box on a new layer at `dst`; a full-canvas box works |
| `stamp_visible` | `doc?`, `name`, `above?` | merged copy of everything visible on a new layer |

### Layers (`layers.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `select_layer` | `doc?`, `layers[]` | selects the layers (first = active), makes doc active; no history state |
| `reorder_layer` | `doc?`, `layer`, one of `above`, `below`, `to` (`top`/`bottom`) | moves the layer in the stack; returns `index`, `moved` |
| `move_layer` | `doc?`, `layers[]`, `dx`/`dy` or `x`/`y` | moves the layers as one block; returns `moved:[{id,bounds}]`, `skipped` |
| `transform_layer` | `doc?`, `layer`, `scale_pct?`, `rotate_deg?`, `cx?`, `cy?` | scale/rotate about the bounds centre, then re-centre |
| `align_layers` | `doc?`, `layers[]`, `to` (`canvas` default, `selection`, `layer` + `to_layer`), `horizontal?`, `vertical?`, `as_group` (default false) | aligns by bounds math and translate; no selection needed |

### Design (`design.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `add_shape` | `doc?`, `kind` (`rect`/`ellipse`/`line`), `bbox` or `from`+`to`+`thickness_px`, `color:{r,g,b}`, `opacity?`, `name`, `above?` | vector shape layer, or a pixel layer when Photoshop refuses the vector make (`vector:false`) |
| `add_layer_style` | `doc?`, `layer`, `style:"drop_shadow"`, `params` (`color`, `opacity` 35, `angle` 120, `distance_px` 6, `spread_pct` 0, `size_px` 10, `blend` multiply) | adds or replaces the drop shadow; other effects kept |
| `set_layer_style` | `doc?`, `layer`, `style:"drop_shadow"`, `params` (only the changes), `enabled?` | edits the shadow in place; `NO_STYLE` without one |
| `clear_layer_style` | `doc?`, `layer` | removes every effect; no step when there are none |

### Shoot workflow (`workflow.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `copy_layers_to` | `src_doc`, `dst_doc`, `layers[]` | copies an adjustment stack with masks onto the top of dst, same order |
| `open_folder` | `path`, `pattern?` | opens up to 50 images in name order |
| `compare_preview` | `doc?`, `layer_ids_off[]`, `max_px` | side-by-side before/after JPEG; no history |
| `contact_sheet` | `docs[]` (1..24), `cols?`, `max_px` | one JPEG tiling several documents |

### Output (`output.ts`)

| Tool | Args | Effect |
| --- | --- | --- |
| `crop` | `doc?`, `ratio?` (`"4:5"`) or `bbox`, `focus?`, `confirm` | crop applied |
| `export` | `doc?`, `shoot`, `filename`, `long_edge_px` (default 1350), `quality` (1..12, default 10), `preset?` (`post`/`story`), `focus?`, `confirm` | duplicate doc → (preset crop) → convert to sRGB → resize → save JPEG to `<PSLAB_EXPORT_ROOT>/<shoot>/<filename>` → close copy |
| `save` | `doc?`, `path?`, `format` (`psd`/`jpg`), `confirm` | saves |
| `save_psd` | `doc?`, `shoot?` or `folder?`, `confirm` | layered PSD copy next to the exports; never overwrites |

`confirm` must be literally `true` or the tool returns an error without
touching anything. Flatten and close document are not exposed.

### Developer (`dev.ts`)

`dev_events` returns (and with `clear` empties) the Photoshop events the
plugin recorded, for discovering batchPlay descriptors. Recorded descriptors
live in `plugin/lib/recorded/` (see its README).

## v0.3 (waves A and B, 2026-11-16/17)

Input: `docs/handoff-2026-11-15.md`; plan: `docs/plans/2026-11-16-v03-waves-ab.md`.
34 tools before, 45 now. Built and unit-tested; live verification in
Photoshop is still pending (see the development log).

New tools (11):

- `stamp_visible`: merged copy of everything visible on a new layer.
- `select_layer`: select layers without a history state.
- `reorder_layer`: move a layer in the stack (`above`, `below`, `to`).
- `move_layer`: move layers as one block, relative or absolute.
- `transform_layer`: scale, rotate, re-centre one layer.
- `align_layers`: align to canvas, selection or a layer, optionally as a group.
- `add_shape`: rect, ellipse or line as a shape layer (pixel fallback).
- `add_layer_style`, `set_layer_style`, `clear_layer_style`: drop shadow.
- `set_blur`: change an existing smart-filter blur radius.

Changed behaviour:

- `get_document`: per-layer `bounds` and `maskEnabled`, `text` on text
  layers, and `modal`. Layer tools that fail while Photoshop is modal answer
  `MODAL_BUSY` instead of `NO_LAYER`.
- `above` on `add_pixel_layer`, `copy_to`, `clone_from` and
  `content_aware_fill` (the new layer is released from any clipping group).
- `content_aware_fill`: `sample` / `sample_layers`; a region covering the
  canvas is refused with `INVALID_ARGS` before any batchPlay.
- `clone_from`: a full-canvas `src_bbox` skips the inverse-and-delete that
  raised a blocking Photoshop alert (bug 10).
- `delete_layer`: `layers` deletes several in one step.
- `add_adjustment`: clears any active selection first.
- Mask writes redraw the layer and re-target RGB (bug 1).
- `render_preview`, `region_stats` and internal patch reads avoid exact
  integer downscale ratios (bug 9).
- New hints profile `edit` for relative changes.

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
    src/tools/*.ts   one file per tool group (see, edit, masks, composite, geometry,
                     layers, design, workflow, output, dev)
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
