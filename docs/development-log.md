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
