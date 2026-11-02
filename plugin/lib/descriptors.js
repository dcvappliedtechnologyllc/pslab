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

function makeAdjustment(type, params, name) {
  const p = params || {};
  switch (type) {
    case "curves": {
      const points = p.points || {};
      let adjustment = CURVE_CHANNELS.filter(([k]) => Array.isArray(points[k])).map(([k, ch]) => ({
        _obj: "curvesAdjustment",
        channel: { _ref: "channel", _enum: "channel", _value: ch },
        curve: points[k].map(([x, y]) => ({ _obj: "paint", horizontal: x, vertical: y })),
      }));
      if (adjustment.length === 0) {
        adjustment = [{
          _obj: "curvesAdjustment",
          channel: { _ref: "channel", _enum: "channel", _value: "composite" },
          curve: [[0, 0], [255, 255]].map(([x, y]) => ({ _obj: "paint", horizontal: x, vertical: y })),
        }];
      }
      return [
        makeLayerDescriptor(name, { _obj: "curves", presetKind: presetKind("presetKindDefault") }),
        { _obj: "set", _target: adjTarget(),
          to: { _obj: "curves", presetKind: presetKind("presetKindCustom"), adjustment } },
      ];
    }
    case "hue_sat":
      return [
        makeLayerDescriptor(name, { _obj: "hueSaturation", presetKind: presetKind("presetKindDefault") }),
        { _obj: "set", _target: adjTarget(),
          to: { _obj: "hueSaturation", adjustment: [{
            _obj: "hueSatAdjustmentV2", hue: num(p.hue), saturation: num(p.saturation), lightness: num(p.lightness),
          }] } },
      ];
    case "exposure":
      return [makeLayerDescriptor(name, {
        _obj: "exposure", exposure: num(p.exposure), offset: num(p.offset), gammaCorrection: num(p.gamma, 1),
      })];
    case "brightness_contrast":
      return [makeLayerDescriptor(name, {
        _obj: "brightnessEvent", brightness: num(p.brightness), center: num(p.contrast), useLegacy: false,
      })];
    case "vibrance":
      return [makeLayerDescriptor(name, {
        _obj: "vibrance", vibrance: num(p.vibrance), saturation: num(p.saturation),
      })];
    default: {
      const err = new Error(`Adjustment type not supported: ${type}`);
      err.code = "NOT_SUPPORTED";
      throw err;
    }
  }
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

function transform({ scalePct, dx = 0, dy = 0 }) {
  return {
    _obj: "transform",
    _target: layerTarget(),
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    width: pct(scalePct),
    height: pct(scalePct),
    linked: true,
    angle: { _unit: "angleUnit", _value: 0 },
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
  selectLayerById, makeAdjustment, clipToBelow, makeMaskFromSelection, selectMaskChannel, selectRgbChannel,
  invert, setMaskFeather, selectRectangle, selectPolygon, objectSelect, selectSubject, contract, feather,
  fill, transform, convertToSRGB, saveJpeg, newPlacedLayer, gaussianBlur, defringe, duplicateLayerTo,
};
