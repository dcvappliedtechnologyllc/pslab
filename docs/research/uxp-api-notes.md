# UXP / Photoshop 27.x API notes (web research, 2026-11-01)

Trust tags: [ADOBE] Adobe docs; [CODE] observed in public plugins;
[FORUM] forum posts; [INFERRED] reconstructed from Action Manager naming, must
be verified by recording; [UNCERTAIN] unsettled.

## 1. Manifest v5 and the localhost WebSocket

[ADOBE] https://developer.adobe.com/photoshop/uxp/2022/guides/uxp_guide/uxp-misc/manifest-v5/

```json
{
  "manifestVersion": 5, "id": "...", "name": "...", "version": "1.0.0", "main": "index.html",
  "host": { "app": "PS", "minVersion": "27.0.0" },
  "entrypoints": [ { "type": "panel", "id": "main", "label": {"default": "pslab"},
      "minimumSize": {"width": 230, "height": 200}, "maximumSize": {"width": 2000, "height": 2000},
      "preferredDockedSize": {"width": 230, "height": 300}, "preferredFloatingSize": {"width": 230, "height": 300},
      "icons": [ {"width":23,"height":23,"path":"icons/dark.png","scale":[1,2],"theme":["darkest","dark","medium"]},
                 {"width":23,"height":23,"path":"icons/light.png","scale":[1,2],"theme":["lightest","light"]} ] } ],
  "requiredPermissions": {
    "network": { "domains": [ "..." ] },
    "localFileSystem": "fullAccess",
    "clipboard": "readAndWrite",
    "launchProcess": { "schemes": [ "https" ], "extensions": [ ".psd" ] }
  }
}
```

- Default deny: permissions not declared are not granted.
- `localFileSystem`: `"request"`, `"plugin"` (default), `"fullAccess"`.
- `network.domains`: list or `"all"`. Wildcard TLDs unsupported since UXP 7.4.
- UXP supports WebSocket **clients only** [ADOBE]. The server must be ours.
- macOS blocks plain http in some cases; docs never mention `ws://localhost`.
- [FORUM, UNCERTAIN] what works in `domains`: one answer lists
  `"http://localhost/"` and `"ws://localhost/"` (no port; use `localhost`, not
  `127.0.0.1`). Others needed `"all"`. drmedia/photoshop-mcp (manifest v4) used
  `["localhost","127.0.0.1"]`; dcc-mcp-photoshop uses `ws://localhost:9001` with
  all domains. Recommendation: try specific entries, fall back to `"all"`.
  Threads: forums.creativeclouddeveloper.com/t/websocket-connection-not-working-in-manifestversion-5/6322,
  github.com/AdobeDocs/uxp-photoshop/issues/321.
- macOS 26 Tahoe: open forum posts about localhost HTTP; test early.

## 2. executeAsModal and one history step [ADOBE]

https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/executeasmodal/

```js
async function step(executionContext) {
  const hostControl = executionContext.hostControl;
  const suspensionID = await hostControl.suspendHistory({ documentID, name: "Claude: ..." });
  // modify the document
  await hostControl.resumeHistory(suspensionID);          // commit
  // await hostControl.resumeHistory(suspensionID, false); // roll back
}
await require('photoshop').core.executeAsModal(step, { commandName: "...", interactive: false, timeOut: 30 });
// e.number == 9 -> another plugin holds the modal scope
```

- `resumeHistory(id, commit=true)`; `false` rolls the document back.
- A history state is only created if the document changed.
- Modal scope end auto-resumes suspended history.
- Options: `commandName`, `descriptor`, `interactive` (23.3), `timeOut` seconds (25.10).
- `executionContext`: `isCancelled`, `onCancel`, `reportProgress`,
  `hostControl.registerAutoCloseDocument(docID)`.
- History is per document; a second document needs its own suspension.
- DOM alternative: `document.suspendHistory(callback, name)` (23.0).

[CODE] helper (Stable-Diffusion-PS-WebUI):

```ts
await core.executeAsModal(async ctx => {
  const h = await ctx.hostControl.suspendHistory({ name, documentID })
  try { await fn(ctx); await ctx.hostControl.resumeHistory(h) }
  catch (err) { error = err; await ctx.hostControl.resumeHistory(h, false) }
}, { commandName: name, interactive: false })
```

- Errors thrown inside the modal lose their type: return `{ok,error}` as a
  value and rethrow outside.
- batchPlay does not throw per step; it resolves `{_obj:"error", message}`
  entries. Option `continueOnError` default false.

## 3. New adjustment layers

- Color and Vibrance (temperature/tint added) 27.0 Oct 2025. Clarity & Dehaze
  and Grain 27.3 Jan 2026. **Light** (exposure, contrast, highlights, shadows,
  whites, blacks) 27.10 Aug 2026; Brightness/Contrast now "Legacy controls"
  inside Light. Light: 8/16-bit RGB only.
- API changelog 27.4: `Constants.layerKind` gained Grain and Clarity. Before
  that, reading `layer.kind` on them threw "Invalid value of 'clarity'": wrap
  layer walks in try/catch. Nothing in the changelog about Light.
- **No published batchPlay descriptors** for Light, Clarity/Dehaze, or the
  temperature/tint keys [UNCERTAIN]. Record them: with developer mode on,
  Plugins > Development > Record Action Commands… (actionJSON), or record an
  action and use Actions panel "Copy As JavaScript". Alchemist (jardicc) last
  release 2.7.0 (2023).
- Known fallbacks: `exposure {exposure, offset, gammaCorrection}`,
  `brightnessEvent {brightness, center, useLegacy:false}`, `vibrance {vibrance,
  saturation}`, `curves`, `hueSaturation`, Camera Raw smart filter
  (`_obj:"Adobe Camera Raw Filter"`, keys undocumented).

## 4. batchPlay recipes

Wrap in executeAsModal; add `_options:{dialogOptions:"dontDisplay"}`.

Make adjustment layer [CODE] (CreaCon; nolgia tested on 27.5):

```js
{ _obj:"make", _target:[{_ref:"adjustmentLayer"}],
  using:{ _obj:"adjustmentLayer", name:"Lift", /* group:true clips to below [INFERRED] */
    type:{ _obj:"curves", presetKind:{_enum:"presetKindType",_value:"presetKindCustom"},
      adjustment:[{ _obj:"curvesAdjustment", channel:{_ref:"channel",_enum:"channel",_value:"composite"},
        curve:[{_obj:"paint",horizontal:0,vertical:0},{_obj:"paint",horizontal:128,vertical:121},{_obj:"paint",horizontal:255,vertical:255}] }] } } }
```

- `type` values: `{_obj:"exposure", exposure:0.5, offset:0, gammaCorrection:1}`,
  `{_obj:"vibrance", vibrance:20, saturation:0}`,
  `{_obj:"brightnessEvent", brightness:10, center:5, useLegacy:false}`,
  `{_obj:"hueSaturation", presetKind:{_enum:"presetKindType",_value:"presetKindDefault"}}` then
  `{_obj:"set", _target:[{_ref:"adjustmentLayer",_enum:"ordinal",_value:"targetEnum"}], to:{_obj:"hueSaturation", adjustment:[{_obj:"hueSatAdjustmentV2", hue, saturation, lightness}]}}`.
- Hue/Sat and Curves values did not apply inside `make`; follow with `set`.
- Green = `grain`.
- An active selection becomes the new layer's mask.
- Clip: `group:true` in `using` [INFERRED] or `{_obj:"groupEvent", _target:[{_ref:"layer",_enum:"ordinal",_value:"targetEnum"}]}` [CODE]; DOM `layer.isClippingMask = true`.

Mask from selection [CODE]:

```js
{ _obj:"make", new:{_class:"channel"}, at:{_ref:"channel",_enum:"channel",_value:"mask"},
  using:{_enum:"userMaskEnabled",_value:"revealSelection"} }   // or "hideSelection"
```

- Delete mask: `{_obj:"delete", _target:[{_ref:"channel",_enum:"channel",_value:"mask"}]}`
- Mask feather (non-destructive): `{_obj:"set", _target:[{_ref:"layer",_enum:"ordinal",_value:"targetEnum"}], to:{_obj:"layer", userMaskFeather:{_unit:"pixelsUnit",_value:25.5}}}`; DOM `layer.layerMaskFeather`, `layerMaskDensity`.
- Invert mask [CODE]: select mask channel `{_obj:"select", _target:[{_ref:"channel",_enum:"channel",_value:"mask"}], makeVisible:false}`, `{_obj:"invert"}`, reselect `RGB`. Right after `make mask` the mask is already targeted.

Selections:

- DOM [ADOBE] `doc.selection.selectPolygon(points, mode, feather, antiAlias)`,
  `selectRectangle(bounds,...)`, `feather(by)`, `contract(by)`, `expand`,
  `smooth`, `inverse()`, `deselect()`, `save(name)`, `load`, `makeWorkPath`.
- batchPlay [CODE]: `{_obj:"contract", by:{_unit:"pixelsUnit",_value:r}, selectionModifyEffectAtCanvasBounds:false}`,
  `{_obj:"feather", radius:{_unit:"pixelsUnit",_value:r}, ...}`, `{_obj:"expand", by:...}`,
  `{_obj:"set", _target:[{_ref:"channel",_property:"selection"}], to:{_obj:"rectangle", top:{_unit:"pixelsUnit",_value:t}, left, bottom, right}}`.
- Polygon [FORUM, Action Manager form]: `to:{_obj:"polygon", points:[{_obj:"paint", horizontal:{_unit:"pixelsUnit",_value:x}, vertical:{_unit:"pixelsUnit",_value:y}}, ...]}`.
- Select Subject [CODE]: `{_obj:"autoCutout", sampleAllLayers:false}`. Sky: `{_obj:"selectSky"}`.
- Object Selection in a rect/polygon [FORUM]: same `set` selection plus
  `deepSelect:true, objectSelectionMode:0, magicLassoAutoEnhance:true, smartSubtract:true`.
  Source: community.adobe.com/t5/photoshop-ecosystem-discussions/scripting-the-selection-of-the-object-selection-tool/m-p/13606992

Layer properties: DOM `layer.opacity`, `layer.blendMode = constants.BlendMode.X`,
`layer.visible`, `layer.name`. batchPlay [INFERRED] `{_obj:"set", _target:[{_ref:"layer",_id:id}], to:{_obj:"layer", opacity:{_unit:"percentUnit",_value:50}, mode:{_enum:"blendMode",_value:"multiply"}, name:"x"}}`;
show/hide `{_obj:"show"|"hide", null:[{_ref:"layer",_id:id}]}`. Select layer [CODE]
`{_obj:"select", _target:[{_ref:"layer",_id:id}], makeVisible:false}`.

Gaussian blur: DOM `layer.applyGaussianBlur(r)` (0.1–250); batchPlay
`{_obj:"gaussianBlur", radius:{_unit:"pixelsUnit",_value:r}}` [INFERRED]. For
non-destructive: `{_obj:"newPlacedLayer"}` (convert to smart object) first.

Defringe `{_obj:"defringe", width:{_unit:"pixelsUnit",_value:1}}` [INFERRED];
destructive, pixel layers only.

Painting a stroke on a mask: no batchPlay stroke-along-points command found.
Options: (a) DOM `doc.pathItems.add(name,[subPathInfo])` then
`pathItem.strokePath(ToolType.BRUSH, simulatePressure)` with the mask targeted
(uses current brush tip); (b) **preferred**: rasterize the soft stroke yourself
and write with `imaging.putLayerMask`; (c) polygon selection + feather + fill:
`{_obj:"fill", using:{_enum:"fillContents",_value:"white"|"black"}, opacity:{_unit:"percentUnit",_value:N}, mode:{_enum:"blendMode",_value:"normal"}}`.

## 5. Imaging API [ADOBE]

https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/imaging/

- `getPixels({documentID?, layerID?, historyStateID?, sourceBounds?{left,top,right,bottom}|{left,top,width,height}, targetSize?{width?,height?}, colorSpace?, colorProfile?, componentSize?, applyAlpha?})`
  → `{imageData, sourceBounds, level}`. Omit layerID for the composite.
  `targetSize` with one side scales proportionally.
- `encodeImageData({imageData, base64?})` → **JPEG only**, input must be RGB.
- `getLayerMask({layerID, documentID?, kind:"user"|"vector", sourceBounds?, targetSize?})` → 1-channel.
- `putLayerMask({layerID, imageData, kind:"user", documentID?, replace=true, targetBounds{left,top}?, commandName?})` needs 1-component grayscale.
- `getSelection(...)`, `putSelection({imageData, documentID?, replace=true, targetBounds?, commandName?})`.
- `putPixels({layerID, imageData, documentID?, replace=true, targetBounds?, commandName?})` pixel layers only.
- `createImageDataFromBuffer(typedArray, {width, height, components, colorSpace, colorProfile?, chunky=true, fullRange?})`; masks: `components:1, colorSpace:"Grayscale", colorProfile:"Gray Gamma 2.2"`.
- `imageData.getData({chunky?, fullRange?})` → Uint8Array / Uint16Array (0..32768 unless fullRange) / Float32Array.
- Spaces: RGB, Grayscale, Lab. Always `dispose()`. Writes need executeAsModal
  and collapse into a suspended history step.

## 6. Between documents, transform, profile, export

- DOM `layer.duplicate(relativeObject?: Document|Layer, insertionLocation?, name?)` can target another document. `doc.duplicate(name?, mergeLayersOnly?)`.
- batchPlay `{_obj:"duplicate", _target:[{_ref:"layer",_enum:"ordinal",_value:"targetEnum"}], name, to:{_ref:"document",_id:docId} /*INFERRED*/}`.
- Transform [CODE]:

```js
{ _obj:"transform", _target:[{_ref:"layer",_id:layerId}],
  freeTransformCenterState:{_enum:"quadCenterState",_value:"QCSAverage"},
  width:{_unit:"percentUnit",_value:sx}, height:{_unit:"percentUnit",_value:sy}, linked:true,
  angle:{_unit:"angleUnit",_value:0},
  offset:{_obj:"offset", horizontal:{_unit:"pixelsUnit",_value:dx}, vertical:{_unit:"pixelsUnit",_value:dy}},
  interfaceIconFrameDimmed:{_enum:"interpolationType",_value:"bicubic"} }
```

  DOM: `layer.scale(w,h,anchor?,{interpolation})`, `layer.translate(dx,dy)`.
- Profile: DOM `doc.convertProfile(dest, intent, blackPointCompensation?, dither?)`; batchPlay [CODE]
  `{_obj:"convertToProfile", _target:[{_ref:"document",_enum:"ordinal",_value:"targetEnum"}], to:"sRGB IEC61966-2.1", intent:{_enum:"intent",_value:"colorimetric"}, mapBlack:true, dither:true, flatten:false, rasterizePlaced:false, shadowMode:-1}`.
- Save: DOM `doc.saveAs.jpg(entry, {quality:0..12, embedColorProfile}, asCopy)`; batchPlay silent [CODE]
  `const token = await require('uxp').storage.localFileSystem.createSessionToken(entry);`
  `{_obj:"save", as:{_obj:"JPEG", extendedQuality:10, matteColor:{_enum:"matteColor",_value:"white"}}, in:{_kind:"local",_path:token}, copy:true, lowerCase:true}`.
- sRGB JPEG route: duplicate doc → convertProfile sRGB → resize → saveAs.jpg copy → close without saving (`registerAutoCloseDocument`).
- `fullAccess` lets `fs.getEntryWithUrl("file:/...")` work without a picker.

## 7. UXP Developer Tool

- Install: Creative Cloud desktop > All apps > search "UXP Developer Tools".
  First launch: Enable developer mode (admin). Manual fallback: create
  `/Library/Application Support/Adobe/UXP/Developer/settings.json` with `{"developer": true}`.
- Photoshop Preferences > Plugins > Enable Developer Mode (shows Plugins > Development menu).
- Sideload: Add Plugin → manifest.json → ••• → Load / Reload / Watch / Debug.
- Without UDT: Package to `.ccx`, double-click (CC Desktop installs), or
  `UnifiedPluginInstallerAgent --install plugin.ccx` from
  `/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/macOS`.

## 8. Photoshop 27.x changes

- No manifest v6; v5 current. UXP 9.x.
- 27.9: new UI backend can affect panel rendering.
- 27.10: Light layer; Brightness/Contrast legacy inside it.
- Quirks on 27.5: `createLayerGroup` nests inside a top group; `app.documents.add()` may return null, read `app.activeDocument`; compare layers by id.

## Gaps to settle by recording in Photoshop 27.10+

1. Light, Clarity/Dehaze, Color & Vibrance (temperature/tint) `make` descriptors.
2. `group:true` at creation.
3. Duplicate layer to another document with `to:{_ref:"document"}`.
4. Defringe and gaussianBlur key names.
5. Which `network.domains` entry lets `ws://localhost` through on macOS 26.
