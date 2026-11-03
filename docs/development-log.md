# Bring-up log

## 2026-11-01, Photoshop 27.11.0, macOS 26, UXP Developer Tool

Harness: `node scripts/dev-harness.mjs` (real server + in-memory MCP client on
127.0.0.1:9778). Plugin sideloaded from UDT.

### Phase 0 — PASS
- UDT needed Photoshop's own "Enable Developer Mode" (Preferences > Plugins)
  **and a Photoshop restart**; the first Load failed with "Failed to load the
  devtools plugin" until the restart.
- Manifest `network.domains` with `ws://localhost:9777` etc. works on macOS 26.
  No `"all"` needed. The plugin dials `ws://localhost`, server binds 127.0.0.1.
- **Bug found and fixed:** UXP `require` does not resolve a directory to its
  `index.js`. `require("../recorded")` threw "Module not found" at load, so no
  panel handler was ever attached and Connect did nothing. Now
  `require("../recorded/index")` (commit ed605ed).
- `ps.app.version` is undefined in UXP; hello now uses `require("uxp").host.version`
  (27.11.0).
- Panel clicks from the computer-use background mode do not reach UXP panels;
  a real (full-screen) click or `document.getElementById('toggle').click()`
  from the UDT debugger console works.
- `get_document` lists open docs; `add_pixel_layer` adds one named layer.
- `bits` is reported correctly (8) — the enum-string fix held.

### Phase 1 — PASS
- `render_preview` whole frame: 1126×1500 for a 4000×5328 doc, scale
  3.5523978… = 4000/1126 exactly. Region crops at `max_px` ≥ region size return
  scale 1. `encodeImageData` returns a bare base64 string.
- `region_stats` on a 600×500 bbox: means, 32-bin histogram, clip percentages.
- Done-when: lower shelf in photo A estimated from the preview, then pinned from a
  scale-1 crop at ≈ (1770, 2002)–(2382, 2058) image px.

### Descriptors recorded (Task 10)
- **Light** = `brightnessEvent` with `brightnessMode: brightnessModeLight`;
  values via `set`: `brightnessExposure`, `center` (contrast),
  `brightnessHighlights`, `brightnessShadows`, `brightnessWhites`,
  `brightnessBlacks`. `plugin/lib/recorded/light.js`.
- **Clarity and dehaze** = make `type:{_class:"clarity"}`, set
  `{_obj:"clarity", clarity, dehaze}`.
- **Color and vibrance** = make `type:{_obj:"vibrance", useLegacy:false}`, set
  `{_obj:"vibrance", temperature, tint, vibrance, saturation, useLegacy:false}`.
- **gaussianBlur** `{radius:{_unit:"pixelsUnit",_value}}`; **defringe**
  `{width:{_unit:"pixelsUnit",_value}}` — both match the inferred builders.
- UI edits in the Properties panel do emit `set` events, but late; the reliable
  way to read values is a batchPlay `get` of the layer's `adjustment` property
  from the UDT console.

### Phase 2 — PASS
- `add_adjustment type:light` with the recorded descriptor: Properties panel
  shows +0.35 / +15 / −45 / +45 exactly. New adjustment layers come with a
  white mask by default (so `mask_from_subject` on a fresh adjustment layer will
  refuse; `set_layer mask_invert` or `mask_from_polygon` are the paths).
- `mask_from_polygon` (four corners, invert) → all-black mask;
  `paint_mask` one soft white stroke at 70 % → visible in the thumbnail;
  `set_layer` opacity + name.
- History panel: one state per call, named `Claude: add_adjustment light,…`,
  `Claude: mask_from_polygon, …`, `Claude: paint_mask, 1 strokes`,
  `Claude: set_layer, opacity name`.

### Phase 3 — PASS
- `select_object` (Object Selection inside a bbox) on photo B returned bounds.
- `copy_to` photo B → photo C (sRGB → Display P3), scale 23.9 %, cx 748, cy 1714:
  one call, layer "Object from photo B" at (701,1644)–(795,1783), base on the
  shelf, original covered, no grey fringe at scale 1. Two-document history
  suspension inside one modal was **accepted** by Photoshop 27.11: photo C shows a
  single `Claude: copy_to, Object fro…` state.
- `refine_edge` contract 2 / feather 1 OK; `blur_layer` 0.5 converted to a
  smart object (new id); the mask moves inside the smart object (outer
  `hasMask` false) — expected. `match_tone` computed L −12, S +5 and added two
  clipped layers above the target.
- Stray observation: pressing Return to confirm the Defringe dialog also fired
  two "Master Opacity Change" states (opacity 100 then 0) on the active layer —
  a UI focus quirk, not a plugin issue; undone.

### Left open
- `connect on launch` checkbox: a background click does not toggle it; tick it
  with a real click once.
- Not exercised live yet: `mask_from_subject`, `crop`, `export`, `save`,
  `clarity_dehaze` / `color_vibrance` through `add_adjustment` (recorded files
  are in place; plugin needs a Reload to pick them up).

## 2026-11-02, first real shoot edit with the `interior-photo-edit` skill

Photos: photo A, photo B (camera sRGB) and
photo C (iPhone, Display P3). Lighting plus glare only; no export, no
save; the author chose this up front.

### Server: PORT_BUSY stuck after the other server went away — BUG
- Four pslab servers were running (two from Claude Desktop via the
  `disclaimer` helper, one per Claude Code session). The session's own server
  started while 9777 was held and logged `port 9777 is held by another pslab
  server; retrying every 5 s`.
- After the holders were killed, `lsof` showed the session's server LISTENING
  on 9777 and later ACCEPTING the plugin's socket, yet every tool call kept
  returning exactly: `PORT_BUSY: Port 9777 is held by another pslab server
  (Claude Desktop or another Claude Code session). Quit it, or set
  PSLAB_PORT.` The retry bind succeeded but `portBusy` evidently stayed true
  (or the retry path never ran and something else bound the port under the
  same pid). `bridge.ts` `scheduleRetry` needs a test for this; reproduce by
  starting two servers and killing the first.
- Claude Desktop respawns its pslab server within a second of it being killed,
  so killing holders is a race; a second session cannot win 9777 reliably.
- Workaround that worked: `PSLAB_PORT=9779 node scripts/dev-harness.mjs`
  (HTTP on 9778) and the plugin panel's Port field set to 9779. UXP accepted
  `ws://localhost:9779` under the existing manifest (`ws://localhost` entry).
  Gotcha: the Port field only persists on a `change` event; after a UDT Reload
  it fell back to 9777 and the panel said "Connected" to the stuck server.
  Type the port, press Tab, then Connect; confirm with `lsof -iTCP:9779`.
- All edits below went through the harness (same tool code, in-memory MCP
  client), so the tool behaviour is representative; the MCP stdio path itself
  was not exercised this session.

### Edits — all PASS
- `get_document`: listed the three fresh docs (ids 59, 65, 70) after
  `open -a "Adobe Photoshop 2026" <files>`.
- `render_preview` 1200 px + `region_stats` for assessment: photo A pendant
  region 27.7 % clipped high before any edit; photo B nothing clipped; photo C
  pendant 6.7 % clipped high.
- `add_adjustment type:light` (recorded descriptor, kind `brightnessContrast`,
  white mask by default), one call per doc:
  - photo A (wide, dark camera JPG) "Light 1" id 2: exposure +0.6, contrast +10,
    highlights −50 (pushed from −35 for the pendant), shadows +50 → pendant
    region 0 % clipped afterwards.
  - photo B (close vignette) "Light 1" id 2: +0.35 / +15 / −45 / +45. Marble
    L 186 → 160, still 0 % clipped.
  - photo C (iPhone HEIC) "Light 1" id 2: +0.1 / +11 / −48 / +22 → pendant 0 %
    clipped, ceiling 0.3 % → 0 %.
- Glare: `add_adjustment type:light name:"Glare fix" exposure −1.0, highlights
  −60` → id 3 on photo A and photo C; `set_layer mask_invert:true` turned the default
  white mask black (`ok:true`, `hasMask` stays true); `paint_mask color:white`
  soft strokes at 70 %: photo A one stroke size 380 px along the cabinet faces
  (y≈2900–2940, x 1700→2430); photo C size 200 px along the cabinet faces
  (y 2300, x 380→900) plus size 300 px down the left-wall lamp gradient
  ((110,1750)→(330,2010)). Brush sizes were kept below the skill's 20 % of
  width so the strokes stay 50 px clear of the marble and brass pulls.
  photo B got no Glare layer: its doors are matte black (L 13, no sheen).
- Every call is one history state; nothing saved, cropped or exported. The
  three documents are open and unsaved in Photoshop.

### Left open
- ~~Fix and test the sticky PORT_BUSY in `server/src/bridge.ts`~~ Fixed 2026-11-02:
  the retry path was sound (cross-process kill test added); the port was held by
  an orphaned pslab server whose host had died, which `index.ts` now exits on,
  and PORT_BUSY plus the startup log now name the holder's pid via `lsof`.
- Persist the panel's Port field on input, not only on change.
- Still not exercised live: `mask_from_subject`, `crop`, `export`, `save`,
  `clarity_dehaze` / `color_vibrance`.

## 2026-11-02, finish pass over the MCP stdio path (this time via Claude Code's registered `pslab` server)

Docs: photo B (recovered copy) (59), photo A (recovered copy) (63), photo C (recovered copy) (66), all carrying
Light 1 (and Glare fix on photo A/photo C) from the earlier pass. Lighting + glare + finish, no export,
nothing saved.

- MCP stdio path works end to end from Claude Code (no harness): get_document, render_preview,
  region_stats, add_adjustment with `doc` targeting a non-active document.
- Re-check before finish: photo A pendant 0 % clipped high (was 27.7 % before Light 1); photo C pendant
  and white ceiling 0 %; photo B marble 0 %. No Light changes needed.
- `add_adjustment type:clarity_dehaze` and `type:color_vibrance` work live with the recorded
  descriptors (layer kinds `clarity` / `vibrance`, white mask by default):
  - photo B: Clarity 1 (id 3) clarity 15 dehaze 4; Color 1 (id 4) temperature 5 vibrance 15.
  - photo A: Clarity 1 (id 4) clarity 15 dehaze 4; Color 1 (id 5) temperature 5 vibrance 15.
  - photo C: Clarity 1 (id 4) clarity 12 dehaze 3; Color 1 (id 5) temperature 4 vibrance 12.
- After finish, photo A pendant still 0 % clipped high.
- Known gap confirmed: the `doc` summary in every response describes the ACTIVE document, not
  the `doc` the call targeted (render_preview of 59 reported doc 66's layers). The `result`
  fields are correct. **Fixed** in 13a4c9d: the dispatcher now summarises `args.doc`
  (or `dst_doc`), falling back to the active document; verified live on doc 59 after a Reload.

## 2026-11-02 follower mode

- Claude Desktop spawns two pslab servers (both pids are children of the Claude app), and each Claude Code session spawns one; only one can bind 9777, and the Desktop chat was wired to a copy that lost, so every tool answered PORT_BUSY. Fix: the owner also serves `GET /pslab/health` and `POST /pslab/call` (needs `x-pslab: 1` + JSON) on the same port, and a copy that finds pslab on the port follows it, forwarding calls there and taking over the bind when the owner exits; PORT_BUSY is now only for a non-pslab holder.

## 2026-11-02, add_adjustment dropped by Claude Desktop — FIXED
- The curves point schema used a Zod tuple, which serialises to draft-04
  `items: [schema, schema]`; the Anthropic API rejects that
  ("items must be object,boolean") and Claude Desktop silently drops the whole
  `add_adjustment` tool. Claude Code tolerated it, which is why bring-up missed it.
- Fix: points are `z.array(z.number().min(0).max(255)).length(2)` (same `[x, y]`
  call shape, no doc change). A schema-audit test now fails if any advertised
  tool schema contains tuple-style `items`.

## 2026-11-02, "light returns kind brightnessContrast" — NOT A BUG
- Photoshop's Light layer is `brightnessEvent` with `brightnessMode: brightnessModeLight`, so
  `layer.kind` is `brightnessContrast` by design (recorded 2026-11-01). Measured on photo E
  patch (400,1400)-(1400,2400): mean L 155.2 → 181.8 with exposure +0.6, highlights -50.
  Documented in SKILL.md and README. Possible later nicety: report kind "light" by reading
  brightnessMode per layer in docSummary (one batched get, like hasUserMask).
- Follow-up: get_document now reports `kind: "light"` for brightness layers in light mode
  (one batched `get` of the `adjustment` property per summary; raw kind kept on failure).
  Verified live on photo E: four Light test layers → "light", exposure layer → "exposure".
  The note's "exposure reports brightnessContrast" claim was wrong: that layer was a Light
  layer named "Test exposure". Hidden test layers remain in the test documents; pslab has no
  delete-layer tool by design.

## 2026-11-02 v0.2 P0

- `delete_layer`: built, not yet live-verified.
- `set_adjustment`: built, not yet live-verified.
- `add_adjustment` / `set_adjustment` type `levels`: built, not yet live-verified.
- `white_balance`: built, not yet live-verified.
- Review fixes (same day): `set_adjustment` curves/levels sets always carry all four channels (identity for the ones left out); exposure set carries `presetKindCustom`. **Live-check needed:** `set_adjustment` type `brightness_contrast` sends the plain payload (`brightness`, `center`, `useLegacy: false`, no `brightnessMode`); confirm against a real legacy Brightness/Contrast layer that it edits in place and does not switch the layer to Light mode.
- `white_balance` now anchors its Levels layer directly above the Background (else the bottom-most layer), measures "before" on the Background's own pixels, clears any selection first, and returns `after: null` if the re-measure fails. Built, not yet live-verified.

## 2026-11-02 v0.2 P1 — mask tools: built, not yet live-verified
- New plugin module `plugin/lib/actions/masks.js` and server `server/src/tools/masks.ts`
  (`registerMaskTools`): `mask_from_luminance`, `mask_gradient`, `mask_from_color`,
  `preview_mask`. Pure helpers in `plugin/lib/raster.js` (`luminanceMask`, `gradientMask`,
  `colorMask`, `sampleMean`, `coveragePct`, `grayToRgb`, shared `finishMask` feather).
- Built and unit-tested against the stub `ps` only; none of the four has run in Photoshop yet.
- To check live: full-resolution `getPixels` on a large document (banded read above
  100 MB), `getLayerMask` with `targetSize` (preview_mask also passes full-canvas
  `sourceBounds` so `scale` is canvas width / preview width), `createImageDataFromBuffer`
  with `components: 3, colorSpace: "RGB"` and no `colorProfile`, and `putLayerMask` creating
  a mask on a layer that has none (same path as `paint_mask`).
- `mask_from_color` with `sample` uses two modal scopes: a read-only one for the 5x5 mean
  (so the history state can be named with the colour), then the history step.
- Review rulings (2026-11-02): the two-scope sample read in `mask_from_color` is accepted (the
  history name carries the sampled colour); `coverage_pct` is measured after feather and invert
  (the share the mask reveals); full-canvas `sourceBounds` in `preview_mask` stays pending the
  live check.
- Review fix: `luminanceMask` snaps L to 1e-6 before comparing, since the Rec. 709 weights put
  67 of the 256 neutral greys just below their integer (white was 254.99999999999997, so
  `min_l: 255` returned an empty mask).

## 2026-11-02, v0.2 P2 Geometry and cleanup — built; live-verified below

Stub-tested only (plugin node tests + server vitest). Nothing below has run in Photoshop yet.

- `straighten {doc?, angle_deg? | auto: true, vertical?}`: duplicates the Background (or the bottom
  layer when there is none) with `layer.duplicate()`, names it "Straightened", converts it to a smart
  object (`newPlacedLayer`) and rotates it with Free Transform (`transform` now takes `angleDeg`;
  positive = clockwise). One history state `Claude: straighten, <angle>°`. `auto` reads a 768 px
  composite with `imaging.getPixels` (read-only, before the history step), runs Sobel on luminance and
  takes the peak of a 0.1° histogram of edge tilts within ±12° of vertical (or horizontal); NO_EDGES
  when confidence < 0.05 or fewer than 50 edges. Camera Raw Upright/geometry is NOT used: there is no
  known descriptor for it, so this is a plain rotation, not a perspective fix.
  - Review fix: refuses ALREADY_STRAIGHTENED (before any history state) when a layer named
    "Straightened" exists anywhere in the tree (a hidden one is ignored), since the new copy sits directly above the base and a
    second one would land under the first; delete_layer it (confirm) or hide it first.
  - Patch layers above "Straightened" (content_aware_fill / clone_from results) are NOT rotated with
    it, so straighten first, then clean up.
  - Check live: the sign (a door frame leaning right needs a negative angle; the result must look
    straight), that `newPlacedLayer` keeps the name "Straightened", that the returned layer_id is the
    smart object's id, and auto's measurement on 3 real interiors against a manual measurement.
- `content_aware_fill {doc?, bbox | polygon, name}`: selects the top layer, Stamp Visible
  (`{_obj:"mergeVisible", duplicate:true}`) to a new layer renamed `name`, selects the region, expands
  it 2 px, Content-Aware Fill (`{_obj:"fill", using:{_enum:"fillContents",_value:"contentAware"},
  contentAwareColorAdaptationFill:true, ...}`), Select Inverse (`{_obj:"inverse"}`), Clear
  (`{_obj:"delete"}`), deselect. One history state `Claude: content_aware_fill, <name>`.
  - [INFERRED] descriptors that need live recording with `dev_events`: `fill using contentAware`
    (`D.contentAwareFill()`), `mergeVisible duplicate:true` (`D.stampVisible()`), plus `inverse`
    (`D.inverseSelection()`), `delete` as Clear (`D.clearSelected()`) and `expand` (`D.expand()`).
  - Check live: the stamp lands on top and is a normal pixel layer; the fill result looks right; Clear
    erases only outside the patch (and does not delete the layer); returned bounds = patch + 2 px.
  - Review fix (shared Stamp Visible helper, also used by clone_from): with exactly one layer in the
    document (Background only, or a single layer) Stamp Visible is unavailable, so the helper does a DOM
    `layer.duplicate()` of that layer instead; and when the stamp comes out with `isClippingMask` true
    (stamped above a clipped top layer) it sets it to false so the patch is not clipped.
  - Check live: content_aware_fill and clone_from on a Background-only document (the duplicate path,
    and that the duplicate becomes the selected layer); and on a document whose top layer is clipped
    to the one below (the stamp joins the clipping group, `isClippingMask = false` releases it).
- `clone_from {doc?, src_bbox, dst: {x, y}, name, feather_px?}`: Stamp Visible on top (renamed `name`),
  select src_bbox, Select Inverse, Clear, deselect, then Free Transform offset by
  (dst.x - src_bbox.left, dst.y - src_bbox.top); with feather_px > 0 it selects the moved box, contracts
  and feathers it by feather_px and makes a reveal mask. One history state `Claude: clone_from, <name>`.
  feather_px is refused (INVALID_ARGS) when 2 × feather_px ≥ the box's shorter side, since the contracted
  selection would be empty.
  - Same [INFERRED] descriptors as content_aware_fill: `mergeVisible duplicate:true`, `inverse`, `delete`
    (Clear).
  - Check live: the Free Transform offset moves only the kept pixels by exactly (dx, dy) (transforms
    are centered on the layer bounds, so an offset-only transform should be a pure move); bounds after
    the move; the mask fade looks right at feather 0, 8 and 40.

## 2026-11-02, v0.2 P3 Shoot workflow — built; live-verified below

- `copy_layers_to {src_doc, dst_doc, layers}`: duplicates the listed layers (bottom-most first)
  with DOM `layer.duplicate(dst)`, finds each new layer by the before/after id set (shared
  `resolvePasted` from composite.js), then brings it to the front, so the stack lands on top of
  dst in source order. One history state, in dst only ("Claude: copy_layers_to, N layers");
  src is not activated or changed (the DOM duplicate needs neither), and dst is activated once
  and left active.
  - Check live: a DOM duplicate to another document keeps the layer mask (and adjustment
    settings) with src inactive and no layer selected in it; src's History gets no new state.
  - [INFERRED] `moveLayerToFront`: `{_obj:"move", _target:[{_ref:"layer",_id}], to:{_ref:"layer",
    _enum:"ordinal",_value:"front"}}` (Layer > Arrange > Bring to Front). Record with dev_events.
  - Check live: when dst's active layer is inside a group, the copy may land in that group and
    "front" is then the top of the group, not of the document.
- `open_folder {path, pattern?}`: lists the folder with `getEntryWithUrl("file:" + path)` and
  `getEntries()`, keeps files matching the glob (default: an image-extension list), sorts them
  by name (numeric), and opens them in one `runRead` ("Open folder"); `open_document` now shares
  the `openEntry` helper. At most 50 files; a failing file stops the run with OPEN_FAILED and
  the earlier documents stay open.
  - Check live: `getEntries()` on a folder entry from `getEntryWithUrl` works with
    `localFileSystem: fullAccess` (and HEIC files open from it like open_document does).
- `compare_preview {doc?, layer_ids_off, max_px?}`: inside the new `runScratch` (a suspended
  history step that is always rolled back) reads the composite ("after"), hides the listed
  layers, reads again ("before"), restores visibility in a `finally`, and stitches before | 8 px
  grey | after (plugin/lib/tile.js) into one JPEG.
  - Check live: `createImageDataFromBuffer` RGB (components 3, "sRGB IEC61966-2.1", chunky)
    feeds `encodeImageData` (so far only getPixels imageData was encoded); the rolled-back
    suspension leaves no "Hide Layer" states in History and the layers visible again;
    getPixels after a DOM `visible = false` inside the same modal sees the hidden state.
- `contact_sheet {docs, cols?, max_px?}`: reads each document's composite (getPixels by
  documentID, long edge = cell) in one `runRead` ("Contact sheet") and tiles them centered in
  square cells with 8 px gaps on grey 128 (`tileGrid` in tile.js). The cell size comes from the
  larger of cols and rows so the sheet's long edge stays within max_px.
  - Check live: getPixels of a non-active document's composite with targetSize (16-bit and
    HEIC/Display P3 documents too: the buffer is tagged sRGB, so wide-gamut shots may look
    slightly off in the sheet); the same createImageDataFromBuffer/encodeImageData path as
    compare_preview.

## 2026-11-02, v0.2 P4 Output — built; live-verified below
- `crop` gains `focus: {x, y}` (image px) for ratio crops: the same largest box of the
  aspect, centred on focus and clamped inside the canvas. Without focus the box is
  unchanged. focus with bbox is refused (server toolError, plugin INVALID_ARGS); focus
  must lie inside the canvas.
- `save_psd {doc?, shoot?, folder?, confirm: true}`: layered PSD copy into `folder`
  (absolute, no `..`), else `<export root>/<shoot>`, else the export root. Named after the
  document (`IMG_0118.JPG` -> `IMG_0118.psd`), `-edit` when that is the open document's
  own file, `-2` .. `-99` when taken (then SAVE_EXISTS). Written with
  `createFile(name, {overwrite: false})` and `saveAs.psd(file, {embedColorProfile,
  maximizeCompatibility}, true)`: as a copy, so the open document keeps its own file
  (`save format: psd` rebinds). No history state. Returns `{path, layers}`. Review fix: when
  `saveAs.psd` fails the file createFile made is deleted (a delete error is ignored) so no 0-byte
  PSD is left, and the error comes back as SAVE_FAILED.
- `export` gains `preset: "post" | "story"` (+ optional `focus`): the 4:5 / 9:16 ratio box
  is cropped on the temporary copy (flatten -> crop -> convertProfile -> bits -> resize ->
  save), then the long edge is 1350 / 1920 (1080x1350, 1080x1920); long_edge_px is ignored
  with a preset; no upscaling. Returns `preset` and `crop_bbox` (original px) as well.
  Without a preset the calls are unchanged.
- No batchPlay descriptors: everything uses the DOM (`Document.crop`, `createFile`,
  `saveAs.psd`), so nothing needs recording with dev_events.
- Check live:
  - `createFile(name, {overwrite: false})` really refuses an existing file (the probe via
    `getEntryWithUrl` should already have avoided it) and the probe of a missing file throws.
  - `saveAs.psd(..., true)` on a never-saved document (Untitled-1): it should write the file
    without a dialog and the document should stay untitled; on a saved JPG the document
    title/path must stay the JPG.
  - `Document.path` is the full file path (the `-edit` rule compares it with the target).
  - `export preset: "post"` on a 4000x5328 frame gives 1080x1350 and the open document keeps
    its size and history; `crop` on the duplicate copy works inside the export modal.

## 2026-11-02, v0.2 acceptance run — PASS (no screen control)

Photoshop 27.11.0, plugin loaded from main 42be8b0 (P0 + P1), server from feat/v02-p2-p4 via
`scripts/dev-harness.mjs` (now registers the masks, geometry and workflow tool groups too).
Fresh photo: a fresh camera JPG (test photo F) (3368×6000, sRGB, doc 120), tiled shower wall
with three white dispensers, warm cast.

1. `white_balance bbox` on the middle dispenser body (1440,3120)–(1860,3600), keep_warmth 0.3 →
   Levels layer 2 "White balance", levels red 255 / green 201 / blue 171;
   before {196.3, 155.1, 115.7} → after {196.3, 196.7, 172.4} (blue held back as asked).
2. `add_adjustment light` "Light 1" (+0.35 / +15 / −45 / +45) → layer 3, kind `light`.
3. `add_adjustment light` "Hotspot" (−0.5, highlights −50) → layer 4; `mask_from_luminance
   min_l 200 feather_px 30` → coverage 5.6 %; the tile-sheen patch (480,1080)–(1080,1800) went
   from L 165.8 to 205.4 with Light 1 on, 0 % clipped.
4. `set_adjustment layer 3 type light` exposure +0.5 / highlights −50 → `applied` echoed back.
5. `add_pixel_layer` "Test layer" → id 5; `delete_layer layer 5 confirm:true` → deleted {5, "Test layer"}.
6. `get_document`: Hotspot `light` (mask), Light 1 `light` (mask), White balance `levels` (mask),
   Background `pixel` — kinds correct, one history state per call, nothing saved.

Not run live: the P2–P4 tools themselves (the loaded plugin predates this branch); they stay
"built, not yet live-verified" above. To verify them, reload the plugin from this branch's
`plugin/manifest.json` in the UXP Developer Tool and record the [INFERRED] descriptors with
`dev_events`.

## 2026-11-02, v0.2 P2–P4 live verification — PASS (plugin reloaded from this branch)

Plugin reloaded from this branch's `plugin/` (copied over the checkout the UXP Developer
Tool loads), server via `scripts/dev-harness.mjs`. Docs: IMG_0040.JPG (133) and IMG_0041.JPG
(137) from "Office & Spa Stills", opened with `open_folder`.

- `open_folder pattern:"IMG_0040.JPG"` / `"img_0041.jpg"` (case-insensitive) → one doc each
  with id, name and path. A `[01]` character class matches nothing: only `*` and `?`.
- `straighten auto` on 133: measured 0.0° (confidence 0.121, 12 543 edges, 431 px preview);
  "Straightened" smart object (id 3) above the Background. `angle_deg: 2` on 137 rotates
  clockwise (verticals lean right at the top), so the sign convention holds. A second
  `straighten` on 133 is refused with ALREADY_STRAIGHTENED before any history state.
- `content_aware_fill bbox` (700,4390)–(1030,4610) "Remove pump" on 133 → layer on top,
  bounds = bbox + 2 px; the pump is gone in `compare_preview`. The `mergeVisible duplicate:true`,
  `fill using contentAware`, `expand`, `inverse` and `delete` (Clear) descriptors all ran as
  inferred; no recording needed.
- `clone_from src_bbox` (2100,600)–(2700,1200) → `dst` (300,5200), feather 20 → bounds
  exactly (300,5200)–(900,5800), masked, soft edge visible.
- `compare_preview layer_ids_off:[5,6] max_px:1200` → 1200×1062 (halves 596 wide), before on
  the left, after on the right, layers visible again, no history state left.
- `contact_sheet docs:[59,133,137] max_px:1200` → 1200×1200, 2×2 cells of 588 px, centered.
- `export preset:"post"` → 1080×1350 (crop_bbox top 895..5105); `preset:"story"` with focus →
  1080×1920 (crop 13..6000); plain `long_edge_px:800` → 449×800. Doc 133 still 3368×6000.
- `save_psd shoot:"pslab-live-test"` → `IMG_0040.psd` (4 layers, 223 MB), second call →
  `IMG_0040-2.psd`; the document still reads `IMG_0040.JPG`.
- `crop ratio:"4:5" focus:{3000,5500}` on 137 → bbox (0,1790)–(3368,6000), doc 3368×4210
  (focus clamped to the bottom edge).
- `copy_layers_to` FAILED at the inferred `move … to front` descriptor (BATCHPLAY, empty
  message) and rolled back cleanly (dst unchanged). Replaced by the DOM `layer.bringToFront()`
  (fallback `layer.move(top, ElementPlacement.PLACEBEFORE)`), skipped when the copy already
  lands on top. Re-test after reload: see below.
- After the reload: `copy_layers_to src_doc:59 dst_doc:137 layers:[2,3]` → layer_ids [5, 6]
  ("WB neutralize", "Light 1"), both on top of the Straightened smart object in source order,
  masks kept (`hasMask: true`), one history state in 137. All ten P2–P4 items are live-verified.
