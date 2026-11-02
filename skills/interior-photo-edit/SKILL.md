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
- There is no undo tool. To back out a step, ask the user to undo in Photoshop (Edit > Undo or the History panel), or hide the layer with `set_layer layer:<id> visible:false`.
- Pass `doc` to every layer tool (`add_adjustment`, `mask_from_polygon`, `mask_from_subject`, `paint_mask`, `set_layer`, `refine_edge`, `match_tone`, `blur_layer`) whenever more than one document is open; after `copy_to` that is the destination doc id.

## 0. Connect
- The plugin panel must be open in Photoshop. Call `get_document`; if it fails with not connected, ask the user to open the panel (Plugins > pslab) and click Connect, then retry.
- If no document is open, or the photo the user named is not among `open_docs`, open it yourself with `open_document path:"/path/to/photo.jpg"` (one call per file; the file becomes the active document). Do not ask the user to open files by hand.

## 1. Assess
- `get_document`, then `render_preview` of the whole frame.
- Classify: dark camera JPG (sRGB, 350 ppi) or bright iPhone HEIC (Display P3, 72 ppi).
- `region_stats` on walls, white ceiling or light stone surfaces, and glossy dark surfaces (cabinets, appliances) (note mean luminance and `clipped_high_pct` / `clipped_low_pct`).

## 2. Lighting (one Light layer, top of stack, unclipped)
Call `add_adjustment type:"light" name:"Light 1" params:{...}` using:

| Source | exposure | contrast | highlights | shadows |
| --- | --- | --- | --- | --- |
| Dark camera JPG, wide room | +0.6 | +10 | -35 | +50 |
| Dark camera JPG, close vignette | +0.35 | +15 | -45 | +45 |
| Bright iPhone HEIC | +0.1 | +10 to +12 | -45 to -50 | +15 to +30 |

Push `highlights` further if a light fixture, white ceiling or light stone surface clips. Re-check with `region_stats` (clipped_high_pct) on those areas.

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

## 5. Replace a missing or broken object from a reference shot
1. In the reference doc, `select_object` (`doc` = reference, `bbox` around the object, `mode:"object"`). Select the object alone if it stands free; select the group if objects overlap. `mode:"subject"` picks the main subject of the whole image and ignores `bbox` (the same holds for `mask_from_subject`).
2. Scale from a shared reference object in both frames (e.g. a door handle or a picture frame): `scale_pct` = 100 x ref height in target / ref height in source. Measure heights from `render_preview` with `scale`.
3. `copy_to` with `src_doc`, `use_selection:true`, `dst_doc`, `transform:{scale_pct, cx, cy}`, `name:"Object from reference"`. The profile is converted to the target's space automatically, and `dst_doc` is left active. From here on pass `doc:<dst_doc>` to every layer tool.
4. Seat the base on the surface line (choose `cx, cy` so it does); cover any remaining original fully. If the placement is off, hide the layer (`set_layer visible:false`) or ask the user to undo, then call `copy_to` again.
5. Clean edges: `refine_edge doc:<dst> layer:<new> contract_px:2 feather_px:1 decontaminate:true`; then `paint_mask doc:<dst> color:"black"` over any background wedge left between parts.
6. Match: `blur_layer doc:<dst> radius_px:0.5` for phone shots (use the `layer_id` it returns afterwards; it can change); then call `match_tone doc:<dst> layer:<new> reference_bbox:<neighbor region>` once. It measures both areas and computes its own Hue/Saturation (hue is always 0) and Curves values, clipped to the layer; report the values it returns. To soften it, lower those layers' opacity with `set_layer` rather than calling it again.
7. Add lighting layers above the composite (`add_adjustment doc:<dst> ... above:<composite layer>` or on top of the stack) so one look covers both.

## 6. Instagram export (only when asked)
- `crop doc:<id> ratio:"4:5" confirm:true` (destructive: the pixels outside are discarded).
- `export shoot:<source folder name> filename:"01_living-room.jpg" long_edge_px:1350 quality:10 confirm:true` gives 1080 x 1350 sRGB JPG (quality 10 of 12 is about 85%). Files land in `~/Documents/pslab-exports/<shoot>/<filename>` (the `PSLAB_EXPORT_ROOT` environment variable overrides the root); tell the user the full path.
- Name files in posting order: 01_living-room.jpg, 02_kitchen.jpg.
- Post from the phone app or a desktop scheduler.

## 7. When a tool for the job does not exist

Trigger: the user asks for an edit no pslab tool covers (rotate or straighten, drop shadow,
layer styles, content-aware fill, text, a filter, anything not in the tool list), or a tool
returns `NOT_SUPPORTED`.

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
List each layer added with its values, anything cancelled (pending crops), and that nothing was saved.
