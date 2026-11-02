# adb-mcp reference notes (read-only study, 2026-11-01)

Repo: github.com/mikechambers/adb-mcp, MIT. Studied for patterns only; no code
copied into pslab. Photoshop plugin in `uxp/ps/`, MCP server `mcp/ps-mcp.py`,
relay `adb-proxy-socket/proxy.js`.

## Gaps relative to pslab

No curves, hue/sat or exposure adjustment layers (only B&W, brightness/contrast,
vibrance, color balance). No brush strokes, feather/contract/defringe, profile
conversion, `suspendHistory`, or preview scaling. Descriptors are hand-copied.

## Topology

```
Claude Desktop --stdio--> Python FastMCP --socket.io--> Node proxy :3001 <--socket.io-- UXP plugin
```

- Proxy exists because UXP can only be a socket client.
- Plugin emits `register {application:"photoshop"}`; server emits
  `command_packet`; plugin answers `command_packet_response {packet}` with
  `senderId` echoed; proxy routes back with `io.to(senderId)`.
- No request id: a new socket per tool call, socket id is the correlation.
  20 s timeout; "No clients registered" only logged.
- Command: `{application, action, options}`. Response: `{senderId, status:
  "SUCCESS"|"FAILURE", response, message, document, layers, hasActiveSelection}`.
  The full layer tree returns with every response (worth borrowing).

## Plugin

manifest v5, `host:[{app:"PS",minVersion:"26.0.0"}]`, `requiredPermissions:
{network:{domains:"all"}, localFileSystem:"fullAccess"}`. Panel with a
Connect button and a "connect on launch" checkbox (localStorage).

```js
socket = io("http://localhost:3001", { transports: ["websocket"] });
socket.on("connect", () => socket.emit("register", { application: "photoshop" }));
```

Reconnection relies on socket.io defaults. Plugin must be reloaded in UDT
after every Photoshop restart (sideloaded).

Dispatch: `commandHandlers = {...selection, ...filters, ...core, ...}`;
`handlers[command.action](command)`.

Modal wrapper, no history handling:

```js
const execute = async (callback, commandName = "Executing command...") =>
  core.executeAsModal(callback, { commandName });
```

Layer targeting: `findLayer(id)` recursively, deselect all, `layer.selected =
true`, then batchPlay with `ordinal/targetEnum`.

## Descriptors seen

Adjustment layers: `make` with `_target:[{_ref:"adjustmentLayer"}]`,
`using:{_obj:"adjustmentLayer", type:{...}}`, then `set` on
`{_enum:"ordinal",_ref:"adjustmentLayer",_value:"targetEnum"}`.

- brightness/contrast: `type:{_obj:"brightnessEvent", useLegacy:false}` then
  `to:{_obj:"brightnessEvent", brightness, center: contrast, useLegacy:false}`
- vibrance: `type:{_class:"vibrance"}` then `to:{_obj:"vibrance", saturation, vibrance}`
- color balance: `type:{_obj:"colorBalance", highlightLevels:[0,0,0], midtoneLevels:[0,0,0], shadowLevels:[0,0,0], preserveLuminosity:true}`
- Green is spelled `grain` in descriptors, including `RGBColor {red, grain, blue}`.

Mask from selection:

```js
{ _obj:"make", at:{_enum:"channel",_ref:"channel",_value:"mask"}, new:{_class:"channel"},
  using:{_enum:"userMaskEnabled",_value:"revealSelection"} }
```

Fill: `{ _obj:"fill", color:{_obj:"RGBColor",...}, mode:{_enum:"blendMode",_value:"normal"},
opacity:{_unit:"percentUnit",_value:N}, using:{_enum:"fillContents",_value:"color"} }`

Selections via DOM: `doc.selection.selectRectangle(bounds, SelectionType.REPLACE, feather, antiAlias)`,
`selectPolygon(points, ...)` with points `[{x,y}]`. Select Subject
`{_obj:"autoCutout", sampleAllLayers:false}`; Select Sky `{_obj:"selectSky"}`;
invert `{_obj:"inverse"}`; crop `{_obj:"crop", delete:true}`.

Layer props via DOM: `layer.blendMode = constants.BlendMode.X`, `layer.opacity`,
`layer.visible`, `layer.name`. Clipping: `{_obj:"groupEvent", _target:[ordinal layer]}`.
Reorder: `{_obj:"move", _target:[ordinal layer], to:{_enum:"ordinal",_ref:"layer",_value:"front"}}`.

Gaussian blur: DOM `layer.applyGaussianBlur(radius)`.

Copy/paste: `{_obj:"copyEvent", copyHint:"pixels"}`, `{_obj:"copyMerged"}`,
`{_obj:"paste", antiAlias:{_enum:"antiAliasType",_value:"antiAliasNone"}, as:{_class:"pixel"}, inPlace:true}`.

Transform via DOM: `layer.scale(wPct, hPct, anchor, {interpolation})`,
`layer.translate(dx, dy)`, `layer.rotate`, `layer.duplicate()`.

Place file: `placeEvent` with `null:{_kind:"local", _path: await fs.createSessionToken(entry)}`.

Export: `doc.saveAs.jpg(entry, {quality:9}, true)`, `saveAs.png`, `saveAs.psd`.
`exportDocumentAs` descriptor: `{_obj:"exportDocumentAs", exportAs:{_obj:"exportAsPNG",...}, documentID, saveFile:{_path,_kind:"local"}, overwrite:true}`.

Preview: `imaging.getPixels({applyAlpha:true})` (full res, no targetSize!) then
`imaging.encodeImageData({imageData, base64:true})` → JPEG. Returned to Claude as
FastMCP `Image(data, format="jpeg")`.

## Install

Photoshop Settings > Plugins > Enable Developer Mode, restart. UDT from Creative
Cloud; File > Add Plugin → manifest.json → Load. Plugin > Connect.
