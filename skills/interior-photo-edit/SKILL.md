---
name: interior-photo-edit
description: Edit interior and room photos in Photoshop: lighting, glare, object repair from a reference shot, and Instagram export. Use when asked to brighten, fix glare, add or replace an object, or prep room photos to post.
---

# Interior photo edit

Runs on the pslab MCP tools. Photoshop must be open with the pslab plugin panel connected.

## Rules
- Non-destructive only: adjustment layers, masks, pasted pixel layers. Never edit Background.
- Never crop, flatten, save or export unless asked. Do not call `crop` or `export` otherwise; if a crop was started or planned, cancel it and say so. `crop` is destructive: it discards the pixels outside the box.
- Name every layer for what it does (Light 1, Glare fix, Object from reference) using the `name` argument.
- Every coordinate is in image pixels. With `render_preview`, multiply preview coordinates by the returned `scale` (image px per preview px); never estimate from screen zoom.
- Each tool call is one undo step. After a change, `render_preview` to check it.
- There is no undo tool. To back out a step, hide the layer with `set_layer layer:<id> visible:false`, or remove it with `delete_layer layer:<id> confirm:true` (never the Background; it refuses). To change an adjustment's values, use `set_adjustment` on the layer instead of stacking another one. For anything else ask the user to undo in Photoshop (Edit > Undo or the History panel).
- Pass `doc` to every layer tool (`add_adjustment`, `set_adjustment`, `white_balance`, `mask_from_polygon`, `mask_from_subject`, `mask_from_luminance`, `paint_mask`, `set_layer`, `delete_layer`, `refine_edge`, `match_tone`, `blur_layer`, `straighten`, `content_aware_fill`, `clone_from`, `compare_preview`) whenever more than one document is open; after `copy_to` that is the destination doc id.
- Check your own work with `compare_preview layer_ids_off:[<ids>]` (before on the left, after on the right; it leaves no history state), not by asking the user to look.

## 0. Connect
- The plugin panel must be open in Photoshop. Call `get_document`; if it fails with not connected, ask the user to open the panel (Plugins > pslab) and click Connect, then retry.
- If no document is open, or the photo the user named is not among `open_docs`, open it yourself with `open_document path:"/path/to/photo.jpg"` (one call per file; the file becomes the active document). For a whole shoot, `open_folder path:"/absolute/folder" pattern:"*.JPG"` opens every matching file (at most 50) in name order and returns their ids. Do not ask the user to open files by hand.
- Several shots open: `contact_sheet docs:[ids]` gives one JPEG of all of them to pick from.

## 1. Assess
- `get_document`, then `render_preview` of the whole frame.
- Classify: dark camera JPG (sRGB, 350 ppi) or bright iPhone HEIC (Display P3, 72 ppi).
- `region_stats` on walls, white ceiling or light stone surfaces, and glossy dark surfaces (cabinets, appliances) (note mean luminance and `clipped_high_pct` / `clipped_low_pct`).
- Colour cast (walls or light stone surfaces read warm, green or blue in `region_stats`): `white_balance bbox:<neutral grey/white patch> keep_warmth:0.3` adds a Levels layer directly above the Background and returns before/after means. Tweak it later with `set_adjustment type:"levels"` on the returned `layer_id`, not with a second layer.

## 1b. Straighten (only when verticals lean)
- `straighten auto:true` measures the tilt of the near-vertical lines and rotates a "Straightened" smart-object copy of the Background above it (the Background is never changed); report the measured angle and confidence. Pass `angle_deg` (positive = clockwise, -45..45) instead when the measurement looks wrong; `vertical:false` uses the horizontals (a counter edge) instead.
- The rotation exposes the Background in the corners. Do not crop to hide them unless the user asks (crop is destructive); say in the report that the corners need a crop, and if they ask, `crop ratio:"4:5" focus:{x,y} confirm:true` keeps the subject centred.

## 2. Lighting (one Light layer, top of stack, unclipped)
Call `add_adjustment type:"light" name:"Light 1" params:{...}` using:

| Source | exposure | contrast | highlights | shadows |
| --- | --- | --- | --- | --- |
| Dark camera JPG, wide room | +0.6 | +10 | -35 | +50 |
| Dark camera JPG, close vignette | +0.35 | +15 | -45 | +45 |
| Bright iPhone HEIC | +0.1 | +10 to +12 | -45 to -50 | +15 to +30 |

Push `highlights` further if a light fixture, white ceiling or light stone surface clips. Re-check with `region_stats` (clipped_high_pct) on those areas. To change the values afterwards, `set_adjustment layer:<id> type:"light" params:{...}` (give every param again; left-out ones reset to 0), never a second Light layer.

Hotspot (a window, a light fixture, a blown wall patch): add a second Light layer for it, `add_adjustment type:"light" name:"Hotspot" params:{exposure:-0.5, highlights:-50}`, then limit it to the bright pixels with `mask_from_luminance layer:<id> min_l:200 feather_px:30` (returns `coverage_pct`; aim for a few percent, raise `min_l` if it covers the room). `preview_mask layer:<id>` shows the mask.

A Light layer reports `kind:"light"` in `get_document` (legacy Brightness/Contrast reports `brightnessContrast`). Judge the effect with `region_stats`, not by the kind string alone.

`light` may come back as a group (holding Exposure and Curves layers) when no recorded descriptor is available; the returned `layer_id` is then the group's id, and use that id for masks and `set_layer`. That fallback ignores `whites` and `blacks`.

## 3. Glare on glossy dark surfaces
1. `add_adjustment type:"light" name:"Glare fix" params:{exposure:-1.0, highlights:-60}`.
2. Make its mask black: Photoshop adds a white mask to a new adjustment layer by default, so call `set_layer layer:<id> mask_invert:true`. Only if `get_document` shows the layer without a mask (`hasMask:false`), make a black one instead with `mask_from_polygon` on that layer: the four canvas corners (0,0), (width,0), (width,height), (0,height) from `get_document`, `feather_px:0`, `invert:true`.
3. `paint_mask layer:<id> color:"white" strokes:[{points:[{x,y}, ...], size_px, hardness:0, opacity:0.7}]`: a soft brush, `size_px` about 20% of image width, strokes only on the sheen (cabinet faces, wall gradients). `size_px`, `hardness` and `opacity` go inside each `strokes[]` item, next to its `points`.
4. Keep strokes 50 px clear of bright edges and metal hardware; `paint_mask color:"black"` back over handles or pulls if they dim.

## 4. Finish (optional, per photo)
- Clarity and dehaze: `add_adjustment type:"clarity_dehaze" params:{clarity:12..20, dehaze:0..8}`.
- Color and vibrance: `add_adjustment type:"color_vibrance" params:{temperature:4..8, vibrance:12..20}`.
- These two can return NOT_SUPPORTED; if so, say so in the report and skip them (or approximate with `curves` / `hue_sat` if the user wants).

## 5a. Remove or patch something (no reference shot)
- Remove a cable, outlet, smudge or small object: `content_aware_fill bbox:{...} name:"Remove cable"` (or `polygon:[{x,y},...]`, drawn a little larger than the object). The patch lands on a new layer on top of the stack; the Background is untouched. Check with `compare_preview layer_ids_off:[<patch id>]`; if the fill smears, `delete_layer` it and try a tighter or larger region.
- Cover something with another part of the same surface (a clean stretch of the same wall, floor or counter): `clone_from src_bbox:{...} dst:{x,y} name:"Patch wall" feather_px:12`; `dst` is where the copy's top-left corner lands and `feather_px` fades its edge (keep it under half the box's shorter side). Choose a source lit the same way.
- Do these before the lighting layers so one look covers the patch, or add the patch below them with `above`.

## 5. Replace a missing or broken object from a reference shot
1. In the reference doc, `select_object` (`doc` = reference, `bbox` around the object, `mode:"object"`). Select the object alone if it stands free; select the group if objects overlap. `mode:"subject"` picks the main subject of the whole image and ignores `bbox` (the same holds for `mask_from_subject`).
2. Scale from a shared reference object in both frames (e.g. a door handle or a picture frame): `scale_pct` = 100 x ref height in target / ref height in source. Measure heights from `render_preview` with `scale`.
3. `copy_to` with `src_doc`, `use_selection:true`, `dst_doc`, `transform:{scale_pct, cx, cy}`, `name:"Object from reference"`. The profile is converted to the target's space automatically, and `dst_doc` is left active. From here on pass `doc:<dst_doc>` to every layer tool.
4. Seat the base on the surface line (choose `cx, cy` so it does); cover any remaining original fully. If the placement is off, hide the layer (`set_layer visible:false`) or ask the user to undo, then call `copy_to` again.
5. Clean edges: `refine_edge doc:<dst> layer:<new> contract_px:2 feather_px:1 decontaminate:true`; then `paint_mask doc:<dst> color:"black"` over any background wedge left between parts.
6. Match: `blur_layer doc:<dst> radius_px:0.5` for phone shots (use the `layer_id` it returns afterwards; it can change); then call `match_tone doc:<dst> layer:<new> reference_bbox:<neighbor region>` once. It measures both areas and computes its own Hue/Saturation (hue is always 0) and Curves values, clipped to the layer; report the values it returns. To soften it, lower those layers' opacity with `set_layer` rather than calling it again.
7. Add lighting layers above the composite (`add_adjustment doc:<dst> ... above:<composite layer>` or on top of the stack) so one look covers both.

## 6. Instagram export (only when asked)
- Prefer the preset: `export shoot:<source folder name> filename:"01_living-room.jpg" preset:"post" quality:10 confirm:true` gives a 1080 x 1350 sRGB JPG (4:5, quality 10 of 12 is about 85%); `preset:"story"` gives 1080 x 1920 (9:16). The ratio crop happens on a temporary copy, so the open document keeps its full frame; add `focus:{x,y}` (image px) to centre the crop on the subject instead of the frame centre. Files land in `~/Documents/pslab-exports/<shoot>/<filename>` (the `PSLAB_EXPORT_ROOT` environment variable overrides the root); tell the user the full path and the `crop_bbox` it used.
- Only when the user wants the document itself cropped: `crop doc:<id> ratio:"4:5" focus:{x,y} confirm:true` (destructive: the pixels outside are discarded), then `export ... long_edge_px:1350`.
- Keep the layered file: `save_psd shoot:<source folder name> confirm:true` writes `<name>.psd` next to the exports as a copy (never overwrites: `-edit`, `-2`, ... when the name is taken; the open document keeps pointing at its own file).
- Name in posting order: 01_living-room.jpg, 02_kitchen.jpg.
- Post from the phone app or a desktop scheduler.

## 6b. Same look on the rest of the shoot
- After one photo is done, carry its adjustment stack to the others: `copy_layers_to src_doc:<done> dst_doc:<next> layers:[<Light id>, <Clarity id>, <Color id>]` copies them with their masks onto the top of the next document in the same order (never the Background). Then re-check `region_stats` on the new photo and tweak with `set_adjustment`; masks painted for one frame rarely fit another, so re-mask glare and hotspot layers per photo.
- `contact_sheet docs:[all ids]` to review the set in one image before exporting.

## 7. When a tool for the job does not exist

Trigger: the user asks for an edit no pslab tool covers (perspective or lens correction, drop shadow,
layer styles, text, a filter, anything not in the tool list), or a tool returns `NOT_SUPPORTED`.
Straightening (`straighten`), content-aware fill (`content_aware_fill`) and clone patches
(`clone_from`) are covered now: use the tools, not the screen.

Do both of these, in this order, every time:

1. **Do it on screen, with approval, now.** Say in one line what the gap is and that you will
   drive Photoshop directly. Call `request_access` for Photoshop (and the UXP Developer Tool if
   needed), then `request_full_control`; wait for the approval. Then do the edit with the
   same rules as the tools: non-destructive (a Smart Object or a new layer, never the
   Background), one named layer per change, Photoshop dialogs confirmed by you, and
   `render_preview` afterwards to check. Call `release_full_control` when done. If the user
   declines control, stop that edit and say what is left undone; do not offer a manual
   recipe instead.
2. **Make it a tool for next time** (if your environment can start follow-up tasks). Right after the edit (not before, not instead), start a
   task card with `start_session` (`initiation: "own_initiative"`, `context: "fresh"`) in the
   pslab repo: title `pslab: add <tool_name>`, brief = the exact Photoshop steps you just
   performed, the arguments the tool should take in image pixels, the history-state name, and
   a pointer to `docs/research/uxp-api-notes.md` and `plugin/lib/recorded/README.md` for
   recording the batchPlay descriptor with `dev_events`. Mention the card in the report.

Not a reason to skip either step: "it is only a small edit", "the user can do it faster", "the
crop would be destructive" (ask for the crop like any other, with `confirm: true` once the user
agrees), or "a future tool is overkill".

## 8. Report
List each layer added with its values (and `straighten`'s measured angle, `white_balance`'s before/after means, `content_aware_fill` / `clone_from` regions), anything cancelled (pending crops), any `delete_layer` calls, and that nothing was saved unless `save_psd` or `export` ran (then the paths).
