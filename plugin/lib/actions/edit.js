// Edit actions: each call is one named, undoable history state (runStep).
// Validation happens before runStep so a rejected call never creates a state.
const D = require("../descriptors");
const { runStep, runRead, bp } = require("../step");
const { regionStats, clampBbox } = require("../stats");
const { readPixels } = require("./see");
const { bitsOf, findLayer, kindOverrides, resolveDoc, hasUserMaskStrict } = require("../doc");
const { rasterizeStrokes, polygonMask, imageDataFromMask } = require("../raster");
const defaultRecorded = require("../recorded/index");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const notSupported = (message) => codedError("NOT_SUPPORTED", message);

const safeRead = (read, fallback) => {
  try {
    const v = read();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
};

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

const BUILT_IN = new Set(["curves", "hue_sat", "exposure", "brightness_contrast", "levels"]);

// ---------- levels ----------

const LEVELS_CHANNELS = ["rgb", "red", "green", "blue"];
const LEVELS_FIELDS = ["in_black", "in_white", "gamma", "out_black", "out_white"];
const LEVELS_DEFAULTS = { in_black: 0, in_white: 255, gamma: 1, out_black: 0, out_white: 255 };

// Throws INVALID_ARGS unless params is {rgb?, red?, green?, blue?} of
// {in_black, in_white, out_black, out_white: integers 0..255, gamma 0.1..9.99}
// with in_black < in_white and out_black <= out_white (defaults filled in).
function validateLevels(params) {
  const bad = (m) => codedError("INVALID_ARGS", `levels: ${m}`);
  for (const [ch, v] of Object.entries(params)) {
    if (!LEVELS_CHANNELS.includes(ch)) throw bad(`unknown channel ${ch}; use rgb, red, green, blue`);
    if (!isObj(v)) throw bad(`${ch} must be an object`);
    for (const [k, x] of Object.entries(v)) {
      if (!LEVELS_FIELDS.includes(k)) throw bad(`unknown field ${ch}.${k}`);
      if (typeof x !== "number" || !Number.isFinite(x)) throw bad(`${ch}.${k} must be a number`);
      if (k === "gamma") {
        if (x < 0.1 || x > 9.99) throw bad(`${ch}.gamma must be 0.1..9.99, got ${x}`);
      } else if (!Number.isInteger(x) || x < 0 || x > 255) {
        throw bad(`${ch}.${k} must be an integer 0..255, got ${x}`);
      }
    }
    const f = { ...LEVELS_DEFAULTS, ...v };
    if (!(f.in_black < f.in_white)) throw bad(`${ch}: in_black (${f.in_black}) must be below in_white (${f.in_white})`);
    if (!(f.out_black <= f.out_white)) throw bad(`${ch}: out_black (${f.out_black}) must not exceed out_white (${f.out_white})`);
  }
}

function levelsParts(params) {
  return LEVELS_CHANNELS.filter((ch) => isObj(params[ch])).map((ch) => {
    const f = { ...LEVELS_DEFAULTS, ...params[ch] };
    return `${ch} ${f.in_black} ${f.gamma} ${f.in_white}`;
  });
}
const RECORDED = new Set(["light", "clarity_dehaze", "color_vibrance"]);

function adjustmentHistoryName(type, params, verb = "add_adjustment") {
  let parts;
  if (type === "levels") {
    parts = levelsParts(params);
  } else if (type === "curves") {
    parts = Object.entries(params.points || {})
      .filter(([, pts]) => Array.isArray(pts))
      .map(([ch, pts]) => `${ch} ${pts.length} points`);
  } else {
    parts = Object.entries(params)
      .filter(([, v]) => typeof v === "number")
      .map(([k, v]) => `${k} ${signed(v)}`);
  }
  parts = parts.slice(0, 2);
  return `Claude: ${verb} ${type}${parts.length ? `, ${parts.join(" ")}` : ""}`;
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
  if (type === "levels") validateLevels(params);
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

// ---------- set_adjustment ----------

// The layer kind each add_adjustment type produces (Light layers are
// brightnessContrast in the DOM; kindOverrides tells them apart).
const KIND_OF_TYPE = {
  light: "light",
  curves: "curves",
  hue_sat: "hueSaturation",
  exposure: "exposure",
  brightness_contrast: "brightnessContrast",
  color_vibrance: "vibrance",
  clarity_dehaze: "clarity",
  levels: "levels",
};
const NON_ADJUSTMENT_KINDS = new Set([
  "pixel", "group", "smartObject", "text", "normal", "solidColor", "gradientFill", "pattern", "video", "threeD",
]);

async function layerKind(ps, d, layer) {
  const raw = String(safeRead(() => layer.kind, ""));
  if (raw !== "brightnessContrast") return raw;
  return (await kindOverrides(ps, d)).get(layer.id) || raw;
}

// The `set` descriptor that rewrites an existing adjustment layer of `type`.
function setDescriptor(type, params) {
  if (BUILT_IN.has(type)) return D.setAdjustment(type, params);
  const rec = recordedMap()[type];
  if (!rec || rec.unsupported || !rec.set) {
    throw notSupported(`set_adjustment ${type} needs a recorded set descriptor, and none is available`);
  }
  return applyParams(rec, params)[1];
}

async function set_adjustment(ps, args = {}) {
  const type = args.type;
  const params = args.params || {};
  if (!Object.prototype.hasOwnProperty.call(KIND_OF_TYPE, type)) throw notSupported(`Adjustment type not supported: ${type}`);
  if (type === "levels") validateLevels(params);
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  const kind = await layerKind(ps, d, layer);
  if (NON_ADJUSTMENT_KINDS.has(kind)) {
    throw codedError("NOT_ADJUSTMENT", `Layer ${args.layer} is a ${kind} layer, not an adjustment layer`);
  }
  if (kind !== KIND_OF_TYPE[type]) {
    throw codedError(
      "TYPE_MISMATCH",
      kind === ""
        ? `Layer ${args.layer} has an unknown layer kind; type ${type} edits ${KIND_OF_TYPE[type]} layers`
        : `Layer ${args.layer} is a ${kind} adjustment; type ${type} edits ${KIND_OF_TYPE[type]} layers`,
    );
  }
  const desc = setDescriptor(type, params);
  return stepIn(ps, adjustmentHistoryName(type, params, "set_adjustment"), d, async () => {
    await bp(ps, [D.selectLayerById(args.layer), desc]);
    return { ok: true, applied: params };
  });
}

// ---------- delete_layer ----------

// The Background layer is never deleted: Photoshop flags it isBackgroundLayer,
// and a pixel layer still named "Background" is treated the same way.
function isProtectedLayer(layer) {
  if (safeRead(() => layer.isBackgroundLayer, false) === true) return true;
  return String(safeRead(() => layer.kind, "")) === "pixel" && String(safeRead(() => layer.name, "")) === "Background";
}

// Needs confirm: true here as well as on the server (defence in depth).
async function delete_layer(ps, args = {}) {
  if (args.confirm !== true) throw codedError("CONFIRM_REQUIRED", "Set confirm: true to delete_layer.");
  const { d } = resolveDoc(ps, args.doc);
  const layer = requireLayer(d, args.layer);
  const name = String(safeRead(() => layer.name, ""));
  if (isProtectedLayer(layer)) {
    throw codedError("PROTECTED_LAYER", `Layer ${args.layer} (${name}) is the Background layer and is never deleted`);
  }
  const id = layer.id;
  return stepIn(ps, `Claude: delete_layer, ${name}`, d, async () => {
    await layer.delete();
    return { ok: true, deleted: { id, name } };
  });
}

// ---------- white_balance ----------

const CHANNELS = [["red", "r"], ["green", "g"], ["blue", "b"]];

// Per-channel Levels in_white that makes a patch with mean {r,g,b} neutral.
// Channels are lifted to the brightest one (never pulled down, so nothing
// clips): in_white = 255 * mean / max. keep_warmth (0..1) holds back only the
// temperature (red-blue) part on a warm cast (mean.b < mean.r): blue's target
// becomes max - keep_warmth * (mean.r - mean.b); green (tint) is always fully
// corrected, and a cool or neutral cast ignores keep_warmth. strength (0..1]
// then blends every in_white toward 255 (no change). Rounded, clamped 1..255.
function whiteBalanceLevels(mean, strength = 1, keepWarmth = 0) {
  const max = Math.max(mean.r, mean.g, mean.b);
  const target = { r: max, g: max, b: max };
  if (mean.b < mean.r) target.b = max - keepWarmth * (mean.r - mean.b);
  const out = {};
  for (const [name, k] of CHANNELS) {
    let w = (255 * mean[k]) / target[k];
    w += (255 - w) * (1 - strength);
    out[name] = Math.min(255, Math.max(1, Math.round(w)));
  }
  return out;
}

// layer: measure that layer's own pixels; omitted, the composite.
async function patchMean(ps, d, bbox, label, layer) {
  const bw = bbox.right - bbox.left;
  const targetSize = bw > 256 ? { width: 256 } : null;
  return runRead(ps, label, async () => {
    const imageData = await readPixels(ps, d, bbox, targetSize, layer);
    try {
      if (imageData.components !== 3) {
        throw codedError("UNSUPPORTED_PIXELS", `Expected 3 RGB components, got ${imageData.components}`);
      }
      const data = await imageData.getData({ chunky: true });
      const { mean } = regionStats(data, imageData.width, imageData.height);
      return { r: mean.r, g: mean.g, b: mean.b };
    } finally {
      imageData.dispose();
    }
  });
}

const unit = (v, dflt, key) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !(v >= 0 && v <= 1)) throw codedError("INVALID_ARGS", `${key} must be 0..1, got ${v}`);
  return v;
};

// The layer white_balance sits directly above: the Background layer, else
// the bottom-most top-level layer. null for a document without layers.
function wbAnchor(d) {
  const layers = Array.from(d.layers || []);
  const bg = layers.find((l) => safeRead(() => l.isBackgroundLayer, false) === true);
  return bg || layers[layers.length - 1] || null;
}

function isRgb(d) {
  const mode = safeRead(() => d.mode, null);
  return mode === null || /rgb/i.test(String(mode)); // unreadable mode: assume RGB
}

async function white_balance(ps, args = {}) {
  const strength = unit(args.strength, 1, "strength");
  if (strength === 0) throw codedError("INVALID_ARGS", "strength 0 would change nothing; use 0 < strength <= 1");
  const keepWarmth = unit(args.keep_warmth, 0, "keep_warmth");
  const name = String(args.name ?? "White balance");
  if (!isObj(args.bbox)) throw codedError("INVALID_BBOX", "bbox is required");
  const { d } = resolveDoc(ps, args.doc);
  if (!isRgb(d)) throw codedError("UNSUPPORTED_MODE", `white_balance needs an RGB document, got ${String(d.mode)}`);
  const bbox = clampBbox(args.bbox, Number(d.width), Number(d.height));
  const anchor = wbAnchor(d);
  // "before" is measured on what the new layer will sit on: the Background's
  // own pixels; the composite when the anchor is not a pixel layer.
  const anchorPixels =
    anchor && (safeRead(() => anchor.isBackgroundLayer, false) === true || String(safeRead(() => anchor.kind, "")) === "pixel");
  const before = await patchMean(ps, d, bbox, "White balance: measure", anchorPixels ? anchor.id : undefined);
  if (Math.max(before.r, before.g, before.b) < 1) {
    throw codedError("DARK_REGION", "The patch is black; pick a grey or white area");
  }
  const levels = whiteBalanceLevels(before, strength, keepWarmth);
  const params = { red: { in_white: levels.red }, green: { in_white: levels.green }, blue: { in_white: levels.blue } };
  const historyName = `Claude: white_balance, R${levels.red} G${levels.green} B${levels.blue}`;
  const layer_id = await stepIn(ps, historyName, d, async () => {
    // a live selection would become the new layer's mask
    await bp(ps, [deselect()]);
    if (anchor) await bp(ps, [D.selectLayerById(anchor.id)]);
    await bp(ps, D.makeAdjustment("levels", params, name));
    return newLayerId(ps);
  });
  let after = null;
  try {
    after = await patchMean(ps, d, bbox, "White balance: verify");
  } catch {
    // the layer is made; a failed re-measure is reported as after: null
  }
  return { levels, before, after, layer_id };
}

module.exports = {
  white_balance, whiteBalanceLevels,
  add_adjustment, add_pixel_layer, mask_from_polygon, mask_from_subject, paint_mask, set_layer, delete_layer, set_adjustment,
  applyParams, setRecorded,
  // shared with masks.js
  codedError, requireLayer, stepIn, toBytes, writeMask,
};
