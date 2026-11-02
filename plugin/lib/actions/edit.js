// Edit actions: each call is one named, undoable history state (runStep).
// Validation happens before runStep so a rejected call never creates a state.
const D = require("../descriptors");
const { runStep, bp } = require("../step");
const { bitsOf, findLayer, resolveDoc, hasUserMaskStrict } = require("../doc");
const { rasterizeStrokes, polygonMask, imageDataFromMask } = require("../raster");
const defaultRecorded = require("../recorded/index");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const notSupported = (message) => codedError("NOT_SUPPORTED", message);

// Test hook: replace the recorded-descriptor map (null restores the files).
let recordedOverride = null;
function setRecorded(map) {
  recordedOverride = map;
}
const recordedMap = () => recordedOverride || defaultRecorded;

function requireLayer(d, id) {
  const layer = findLayer(d, id);
  if (!layer) throw codedError("NO_LAYER", `No layer with id ${id}`);
  return layer;
}

async function activate(ps, d) {
  const active = ps.app.activeDocument;
  if (!active || active.id !== d.id) ps.app.activeDocument = d;
}

function restore(ps, original) {
  try {
    const active = ps.app.activeDocument;
    if (original && (!active || active.id !== original.id)) ps.app.activeDocument = original;
  } catch {
    // the original document may have been closed meanwhile
  }
}

// One history step in d with d active; the document active before the call is
// active again afterwards, on success and on failure.
function stepIn(ps, name, d, fn) {
  const original = ps.app.activeDocument;
  return runStep(ps, name, d.id, async () => {
    try {
      await activate(ps, d);
      return await fn();
    } finally {
      restore(ps, original);
    }
  });
}

// A make leaves the new layer active.
function newLayerId(ps) {
  const layer = Array.from(ps.app.activeDocument.activeLayers || [])[0];
  if (!layer) throw codedError("NO_NEW_LAYER", "The new layer was not found after creating it");
  return layer.id;
}

const num = (params, k) => (typeof params[k] === "number" ? params[k] : 0);
const signed = (v) => `${v >= 0 ? "+" : ""}${v}`;

// ---------- recorded descriptors ----------

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isDescriptor = (v) => isObj(v) && typeof v._obj === "string";
const invalid = (message) => codedError("RECORDED_INVALID", `Recorded descriptor invalid: ${message}`);

// recorded = {make, set?, fields: {param: "make.<path>" | "set.<path>"}} -> [make, set?]
// with every field set to params[param] (0 when absent). A field holding a
// unit value ({_unit,_value}) keeps its unit.
function applyParams(recorded, params = {}) {
  if (!isObj(recorded)) throw invalid("not an object");
  if (!isDescriptor(recorded.make)) throw invalid("make must be a descriptor");
  if (recorded.set !== undefined && !isDescriptor(recorded.set)) throw invalid("set must be a descriptor");
  if (!isObj(recorded.fields)) throw invalid("fields must be an object");
  const out = { make: JSON.parse(JSON.stringify(recorded.make)) };
  if (recorded.set !== undefined) out.set = JSON.parse(JSON.stringify(recorded.set));
  for (const [param, path] of Object.entries(recorded.fields)) {
    if (typeof path !== "string") throw invalid(`path for ${param} must be a string`);
    const keys = path.split(".");
    const root = keys.shift();
    if (!Object.prototype.hasOwnProperty.call(out, root) || keys.length === 0) {
      throw invalid(`path ${path} must start with make. or set.`);
    }
    let node = out[root];
    for (const k of keys.slice(0, -1)) {
      if (node === null || typeof node !== "object" || !(k in node)) throw invalid(`path ${path} not found`);
      node = node[k];
    }
    if (node === null || typeof node !== "object") throw invalid(`path ${path} not found`);
    const leaf = keys[keys.length - 1];
    if (!(leaf in node)) throw invalid(`path ${path} not found`);
    const v = num(params, param);
    node[leaf] = isObj(node[leaf]) && "_unit" in node[leaf] ? { ...node[leaf], _value: v } : v;
  }
  return out.set ? [out.make, out.set] : [out.make];
}

// ---------- add_adjustment ----------

const BUILT_IN = new Set(["curves", "hue_sat", "exposure", "brightness_contrast"]);
const RECORDED = new Set(["light", "clarity_dehaze", "color_vibrance"]);

function adjustmentHistoryName(type, params) {
  let parts;
  if (type === "curves") {
    parts = Object.entries(params.points || {})
      .filter(([, pts]) => Array.isArray(pts))
      .map(([ch, pts]) => `${ch} ${pts.length} points`);
  } else {
    parts = Object.entries(params)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `${k} ${signed(v)}`);
  }
  parts = parts.slice(0, 2);
  return `Claude: add_adjustment ${type}${parts.length ? `, ${parts.join(" ")}` : ""}`;
}

// Fallback Light: Exposure layer plus a Curves layer approximating contrast,
// highlights and shadows.
function lightCurve(params) {
  const s = num(params, "shadows");
  const h = num(params, "highlights");
  const c = num(params, "contrast");
  const clamp = (v) => Math.min(255, Math.max(0, v));
  return [
    [0, Math.max(0, -s / 4)],
    [64, 64 + s / 4 - c / 8],
    [192, 192 + h / 4 + c / 8],
    [255, 255 - Math.max(0, -h / 4)],
  ].map(([x, y]) => [x, clamp(y)]);
}

function lightFallback(params, name) {
  return {
    group: { _obj: "make", _target: [{ _ref: "layerSection" }], using: { _obj: "layerSection", name: name || "Light" } },
    children: [
      ...D.makeAdjustment("exposure", { exposure: num(params, "exposure") }),
      ...D.makeAdjustment("curves", { points: { rgb: lightCurve(params) } }),
    ],
  };
}

async function add_adjustment(ps, args = {}) {
  const type = args.type;
  const params = args.params || {};
  if (!BUILT_IN.has(type) && !RECORDED.has(type)) throw notSupported(`Adjustment type not supported: ${type}`);
  const { d } = resolveDoc(ps, args.doc);
  if (type === "light" && bitsOf(d.bitsPerChannel) === 32) {
    throw notSupported("light is not supported on 32-bit documents");
  }
  const given = (v) => v !== undefined && v !== null;
  if (given(args.above) && given(args.clip_to) && args.above !== args.clip_to) {
    throw codedError(
      "INVALID_ARGS",
      `above (${args.above}) and clip_to (${args.clip_to}) must be the same layer: a clipped layer sits directly above the layer it clips to. Pass only clip_to.`,
    );
  }
  for (const id of [args.above, args.clip_to]) if (id !== undefined && id !== null) requireLayer(d, id);

  let descs = null;
  let group = null;
  if (BUILT_IN.has(type)) {
    descs = D.makeAdjustment(type, params);
  } else {
    const rec = recordedMap()[type];
    if (rec && !rec.unsupported) {
      descs = applyParams(rec, params);
    } else if (type === "light") {
      ({ group, children: descs } = lightFallback(params, args.name));
    } else {
      throw notSupported(`${type} needs a recorded descriptor, and none is available yet`);
    }
  }

  const anchor = args.above ?? args.clip_to;
  return runStep(ps, adjustmentHistoryName(type, params), d.id, async () => {
    await activate(ps, d);
    if (anchor !== undefined && anchor !== null) await bp(ps, [D.selectLayerById(anchor)]);
    let id;
    if (group) {
      await bp(ps, [group]);
      id = newLayerId(ps);
      await bp(ps, descs); // lands inside the selected group
    } else {
      await bp(ps, descs);
      id = newLayerId(ps);
    }
    if (args.clip_to !== undefined && args.clip_to !== null) {
      await bp(ps, [D.selectLayerById(id), D.clipToBelow()]);
    }
    if (args.name !== undefined && !group) requireLayer(d, id).name = args.name;
    return { layer_id: id };
  });
}

// ---------- add_pixel_layer ----------

async function add_pixel_layer(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const using = { _obj: "layer" };
  if (args.name !== undefined) using.name = args.name;
  const name = args.name !== undefined ? `Claude: add_pixel_layer, ${args.name}` : "Claude: add_pixel_layer";
  return runStep(ps, name, d.id, async () => {
    await activate(ps, d);
    await bp(ps, [{ _obj: "make", _target: [{ _ref: "layer" }], using }]);
    return { layer_id: newLayerId(ps) };
  });
}

// ---------- masks ----------

// Any mask buffer -> 8-bit (16-bit data is 0..32768, 32-bit is 0..1).
function toBytes(data) {
  if (data instanceof Uint8Array) return Uint8Array.from(data);
  const scale = data instanceof Uint16Array ? 255 / 32768 : 255;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.min(255, Math.max(0, Math.round(data[i] * scale)));
  return out;
}

async function readMask(ps, d, layerID, w, h) {
  const { imageData } = await ps.imaging.getLayerMask({
    documentID: d.id,
    layerID,
    kind: "user",
    sourceBounds: { left: 0, top: 0, right: w, bottom: h },
  });
  try {
    const data = await imageData.getData({ chunky: true });
    if (data.length !== w * h) {
      throw codedError("MASK_SIZE", `Layer mask is ${data.length} px, expected ${w * h} (${w}x${h})`);
    }
    return toBytes(data);
  } finally {
    imageData.dispose();
  }
}

async function writeMask(ps, d, layerID, buf, w, h) {
  const imageData = await imageDataFromMask(ps, buf, w, h);
  try {
    await ps.imaging.putLayerMask({ documentID: d.id, layerID, imageData, kind: "user", replace: true });
  } finally {
    imageData.dispose();
  }
}

async function mask_from_polygon(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  requireLayer(d, args.layer);
  const w = Number(d.width);
  const h = Number(d.height);
  const points = args.points || [];
  const buf = polygonMask(w, h, points, args.feather_px || 0, !!args.invert);
  return stepIn(ps, `Claude: mask_from_polygon, ${points.length} points`, d, async () => {
    await writeMask(ps, d, args.layer, buf, w, h);
    return { ok: true };
  });
}

const deselect = () => ({
  _obj: "set",
  _target: [{ _ref: "channel", _property: "selection" }],
  to: { _enum: "ordinal", _value: "none" },
});

async function mask_from_subject(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  requireLayer(d, args.layer);
  const { bbox, mode } = args;
  if (mode !== "subject" && mode !== "object") throw codedError("INVALID_MODE", `mode must be subject or object, got ${mode}`);
  if (!bbox) throw codedError("INVALID_BBOX", "bbox is required");
  return stepIn(ps, `Claude: mask_from_subject, ${mode}`, d, async () => {
    await bp(ps, [
      D.selectLayerById(args.layer),
      D.selectRectangle(bbox),
      mode === "subject" ? D.selectSubject() : D.objectSelect(bbox),
      D.makeMaskFromSelection("reveal"),
    ]);
    try {
      await bp(ps, [deselect()]);
    } catch {
      // the mask is made; a lingering selection is harmless
    }
    return { ok: true };
  });
}

async function paint_mask(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  requireLayer(d, args.layer);
  const strokes = args.strokes;
  if (!Array.isArray(strokes) || strokes.length === 0) throw codedError("INVALID_STROKES", "strokes must be a non-empty array");
  if (args.color !== "white" && args.color !== "black") throw codedError("INVALID_COLOR", `color must be white or black, got ${args.color}`);
  const w = Number(d.width);
  const h = Number(d.height);
  return stepIn(ps, `Claude: paint_mask, ${strokes.length} strokes`, d, async () => {
    const base = (await hasUserMaskStrict(ps, d.id, args.layer)) ? await readMask(ps, d, args.layer, w, h) : null;
    const buf = rasterizeStrokes(w, h, strokes, args.color, base);
    await writeMask(ps, d, args.layer, buf, w, h);
    return { ok: true, strokes: strokes.length };
  });
}

// ---------- set_layer ----------

async function set_layer(ps, args = {}) {
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  const changed = ["opacity", "blend", "visible", "name"].filter((k) => args[k] !== undefined);
  if (args.mask_invert === true) changed.push("mask_invert");
  if (changed.length === 0) throw codedError("NOTHING_TO_CHANGE", "set_layer needs at least one property to change");
  let blendMode;
  if (args.blend !== undefined) {
    blendMode = ps.constants.BlendMode[String(args.blend).replace(/[^a-z]/gi, "").toUpperCase()];
    if (blendMode === undefined) throw codedError("INVALID_BLEND", `Unknown blend mode: ${args.blend}`);
  }
  return stepIn(ps, `Claude: set_layer, ${changed.join(" ")}`, d, async () => {
    if (args.opacity !== undefined) layer.opacity = args.opacity;
    if (blendMode !== undefined) layer.blendMode = blendMode;
    if (args.visible !== undefined) layer.visible = args.visible;
    if (args.name !== undefined) layer.name = args.name;
    if (args.mask_invert === true) {
      await bp(ps, [D.selectLayerById(args.layer), D.selectMaskChannel(), D.invert(), D.selectRgbChannel()]);
    }
    return { ok: true };
  });
}

module.exports = {
  add_adjustment, add_pixel_layer, mask_from_polygon, mask_from_subject, paint_mask, set_layer,
  applyParams, setRecorded,
};
