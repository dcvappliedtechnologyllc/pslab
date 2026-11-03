// Pure batchPlay descriptor builders. No Photoshop requires; every call returns fresh objects.
// Shapes from docs/research/uxp-api-notes.md sections 4 and 6.

const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const pct = (v) => ({ _unit: "percentUnit", _value: v });
const layerTarget = () => [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }];
const adjTarget = () => [{ _ref: "adjustmentLayer", _enum: "ordinal", _value: "targetEnum" }];
const selectionTarget = () => [{ _ref: "channel", _property: "selection" }];
const presetKind = (v) => ({ _enum: "presetKindType", _value: v });
const num = (v, dflt = 0) => (typeof v === "number" ? v : dflt);

function selectLayerById(id) {
  return { _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false };
}

function makeLayerDescriptor(name, type) {
  const using = { _obj: "adjustmentLayer", type };
  if (name !== undefined) using.name = name;
  return { _obj: "make", _target: [{ _ref: "adjustmentLayer" }], using };
}

const CURVE_CHANNELS = [
  ["rgb", "composite"],
  ["red", "red"],
  ["green", "grain"], // green is spelled "grain" in descriptors
  ["blue", "blue"],
];

function notSupported(type) {
  const err = new Error(`Adjustment type not supported: ${type}`);
  err.code = "NOT_SUPPORTED";
  return err;
}

// full: one entry per channel (composite, red, grain, blue), identity for the
// channels not given, so a set replaces every channel. Without full (make),
// only the channels given, or an identity composite when none is.
function curvesTo(p, full = false) {
  const points = p.points || {};
  const IDENTITY = [[0, 0], [255, 255]];
  const channels = full ? CURVE_CHANNELS : CURVE_CHANNELS.filter(([k]) => Array.isArray(points[k]));
  let adjustment = channels.map(([k, ch]) => ({
    _obj: "curvesAdjustment",
    channel: { _ref: "channel", _enum: "channel", _value: ch },
    curve: (Array.isArray(points[k]) ? points[k] : IDENTITY).map(([x, y]) => ({ _obj: "paint", horizontal: x, vertical: y })),
  }));
  if (adjustment.length === 0) {
    adjustment = [{
      _obj: "curvesAdjustment",
      channel: { _ref: "channel", _enum: "channel", _value: "composite" },
      curve: [[0, 0], [255, 255]].map(([x, y]) => ({ _obj: "paint", horizontal: x, vertical: y })),
    }];
  }
  return { _obj: "curves", presetKind: presetKind("presetKindCustom"), adjustment };
}

const hueSatTo = (p) => ({
  _obj: "hueSaturation", adjustment: [{
    _obj: "hueSatAdjustmentV2", hue: num(p.hue), saturation: num(p.saturation), lightness: num(p.lightness),
  }],
});

const exposureTo = (p) => ({
  _obj: "exposure", exposure: num(p.exposure), offset: num(p.offset), gammaCorrection: num(p.gamma, 1),
});

const brightnessTo = (p) => ({
  _obj: "brightnessEvent", brightness: num(p.brightness), center: num(p.contrast), useLegacy: false,
});

// Levels per channel {in_black, in_white, gamma, out_black, out_white},
// defaults 0/255/1/0/255; one levelsAdjustment per channel given, or an
// identity composite entry when none is.
function levelsTo(p, full = false) {
  const entry = (ch, v) => ({
    _obj: "levelsAdjustment",
    channel: { _ref: "channel", _enum: "channel", _value: ch },
    input: [num(v.in_black, 0), num(v.in_white, 255)],
    gamma: num(v.gamma, 1),
    output: [num(v.out_black, 0), num(v.out_white, 255)],
  });
  const given = (k) => p[k] && typeof p[k] === "object";
  const channels = full ? CURVE_CHANNELS : CURVE_CHANNELS.filter(([k]) => given(k));
  let adjustment = channels.map(([k, ch]) => entry(ch, given(k) ? p[k] : {}));
  if (adjustment.length === 0) adjustment = [entry("composite", {})];
  return { _obj: "levels", presetKind: presetKind("presetKindCustom"), adjustment };
}

const vibranceTo = (p) => ({ _obj: "vibrance", vibrance: num(p.vibrance), saturation: num(p.saturation) });

// The adjustment payload for a built-in type (the `to` of its set). full:
// the payload for editing an existing layer (every channel, preset kinds).
function adjustmentTo(type, p, full = false) {
  switch (type) {
    case "curves": return curvesTo(p, full);
    case "hue_sat": return hueSatTo(p);
    case "levels": return levelsTo(p, full);
    case "exposure":
      return full ? { _obj: "exposure", presetKind: presetKind("presetKindCustom"), ...exposureTo(p) } : exposureTo(p);
    case "brightness_contrast": return brightnessTo(p);
    case "vibrance": return vibranceTo(p);
    default: throw notSupported(type);
  }
}

function makeAdjustment(type, params, name) {
  const p = params || {};
  switch (type) {
    case "curves":
      return [
        makeLayerDescriptor(name, { _obj: "curves", presetKind: presetKind("presetKindDefault") }),
        setDescriptor("curves", p, false),
      ];
    case "hue_sat":
      return [
        makeLayerDescriptor(name, { _obj: "hueSaturation", presetKind: presetKind("presetKindDefault") }),
        setDescriptor("hue_sat", p, false),
      ];
    case "levels":
      return [
        makeLayerDescriptor(name, { _obj: "levels", presetKind: presetKind("presetKindDefault") }),
        setDescriptor("levels", p, false),
      ];
    case "exposure":
    case "brightness_contrast":
    case "vibrance":
      return [makeLayerDescriptor(name, adjustmentTo(type, p))];
    default:
      throw notSupported(type);
  }
}

function setDescriptor(type, params, full) {
  return { _obj: "set", _target: adjTarget(), to: adjustmentTo(type, params || {}, full) };
}

// Edit the selected adjustment layer in place (select it first with
// selectLayerById). Curves and levels carry all four channels (identity for
// those not given) so omitted channels reset; exposure adds presetKindCustom.
// Otherwise the payloads makeAdjustment uses.
function setAdjustment(type, params) {
  return setDescriptor(type, params, true);
}

function clipToBelow() {
  return { _obj: "groupEvent", _target: layerTarget() };
}

function makeMaskFromSelection(mode) {
  return {
    _obj: "make",
    new: { _class: "channel" },
    at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: mode === "hide" ? "hideSelection" : "revealSelection" },
  };
}

function selectChannel(value) {
  return { _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: value }], makeVisible: false };
}
const selectMaskChannel = () => selectChannel("mask");
const selectRgbChannel = () => selectChannel("RGB");

function invert() {
  return { _obj: "invert" };
}

function setMaskFeather(pixels) {
  return { _obj: "set", _target: layerTarget(), to: { _obj: "layer", userMaskFeather: px(pixels) } };
}

// bbox: {left, top, right, bottom} in pixels.
function selectRectangle(bbox) {
  return {
    _obj: "set",
    _target: selectionTarget(),
    to: { _obj: "rectangle", top: px(bbox.top), left: px(bbox.left), bottom: px(bbox.bottom), right: px(bbox.right) },
  };
}

// points: [{x, y}] in pixels.
function selectPolygon(points) {
  return {
    _obj: "set",
    _target: selectionTarget(),
    to: {
      _obj: "polygon",
      points: points.map((pt) => ({ _obj: "paint", horizontal: px(pt.x), vertical: px(pt.y) })),
    },
  };
}

function objectSelect(bboxOrPoints) {
  const base = Array.isArray(bboxOrPoints) ? selectPolygon(bboxOrPoints) : selectRectangle(bboxOrPoints);
  return { ...base, deepSelect: true, objectSelectionMode: 0, magicLassoAutoEnhance: true, smartSubtract: true };
}

function selectSubject() {
  return { _obj: "autoCutout", sampleAllLayers: false };
}

function contract(pixels) {
  return { _obj: "contract", by: px(pixels), selectionModifyEffectAtCanvasBounds: false };
}

function feather(pixels) {
  return { _obj: "feather", radius: px(pixels), selectionModifyEffectAtCanvasBounds: false };
}

function fill(color, opacityPct) {
  return {
    _obj: "fill",
    using: { _enum: "fillContents", _value: color },
    opacity: pct(opacityPct),
    mode: { _enum: "blendMode", _value: "normal" },
  };
}

// angleDeg: Free Transform rotation in degrees, positive = clockwise (Photoshop's convention).
function transform({ scalePct, dx = 0, dy = 0, angleDeg = 0 }) {
  return {
    _obj: "transform",
    _target: layerTarget(),
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    width: pct(scalePct),
    height: pct(scalePct),
    linked: true,
    angle: { _unit: "angleUnit", _value: angleDeg },
    offset: { _obj: "offset", horizontal: px(dx), vertical: px(dy) },
    interfaceIconFrameDimmed: { _enum: "interpolationType", _value: "bicubic" },
  };
}

function convertToSRGB() {
  return {
    _obj: "convertToProfile",
    _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    to: "sRGB IEC61966-2.1",
    intent: { _enum: "intent", _value: "colorimetric" },
    mapBlack: true,
    dither: true,
    flatten: false,
    rasterizePlaced: false,
    shadowMode: -1,
  };
}

function saveJpeg(token, quality) {
  return {
    _obj: "save",
    as: { _obj: "JPEG", extendedQuality: quality, matteColor: { _enum: "matteColor", _value: "white" } },
    in: { _kind: "local", _path: token },
    copy: true,
    lowerCase: true,
  };
}

// Stamp Visible (Cmd+Opt+Shift+E): a new pixel layer above the active layer
// holding the visible composite. verified live on PS 27.11 (2026-11-02): it ran inside content_aware_fill / clone_from with the expected result
function stampVisible() {
  return { _obj: "mergeVisible", duplicate: true };
}

// Edit > Fill > Content-Aware into the active selection on the active layer.
// verified live on PS 27.11 (2026-11-02): it ran inside content_aware_fill / clone_from with the expected result
function contentAwareFill() {
  return {
    _obj: "fill",
    using: { _enum: "fillContents", _value: "contentAware" },
    contentAwareColorAdaptationFill: true,
    contentAwareRotationFill: false,
    contentAwareScaleFill: false,
    contentAwareMirrorFill: false,
    opacity: pct(100),
    mode: { _enum: "blendMode", _value: "normal" },
  };
}

// Select > Modify > Expand. shape mirrors contract (uxp-api-notes section 5); verified live on PS 27.11 (2026-11-02)
function expand(pixels) {
  return { _obj: "expand", by: px(pixels), selectionModifyEffectAtCanvasBounds: false };
}

// Select > Inverse (the selection, not the pixels: see invert()). verified live on PS 27.11 (2026-11-02): it ran inside content_aware_fill / clone_from with the expected result
function inverseSelection() {
  return { _obj: "inverse" };
}

// Edit > Clear: erase the selected pixels of the active pixel layer.
// verified live on PS 27.11 (2026-11-02): it ran inside content_aware_fill / clone_from with the expected result
function clearSelected() {
  return { _obj: "delete" };
}

function deselect() {
  return { _obj: "set", _target: selectionTarget(), to: { _enum: "ordinal", _value: "none" } };
}

function newPlacedLayer() {
  return { _obj: "newPlacedLayer" };
}

function gaussianBlur(pixels) {
  return { _obj: "gaussianBlur", radius: px(pixels) };
}

function defringe(pixels) {
  return { _obj: "defringe", width: px(pixels) };
}

function duplicateLayerTo(docId, name) {
  const d = { _obj: "duplicate", _target: layerTarget(), to: { _ref: "document", _id: docId } };
  if (name !== undefined) d.name = name;
  return d;
}

module.exports = {
  selectLayerById, makeAdjustment, setAdjustment, clipToBelow, makeMaskFromSelection, selectMaskChannel, selectRgbChannel,
  invert, setMaskFeather, selectRectangle, selectPolygon, objectSelect, selectSubject, contract, feather,
  fill, transform, convertToSRGB, saveJpeg, newPlacedLayer, gaussianBlur, defringe, duplicateLayerTo,
  stampVisible, contentAwareFill, expand, inverseSelection, clearSelected, deselect,
};
