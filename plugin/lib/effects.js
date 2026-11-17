// Pure layer-style (layerEffects) helpers for add/set/clear_layer_style.
// A `set` of layerEffects replaces the layer's whole effect set, so every
// change starts from the current effects (a batchPlay `get`) and merges.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const invalid = (message) => codedError("INVALID_ARGS", message);

// Keys of a layerEffects descriptor that are not effects.
const META = new Set(["_obj", "scale", "masterFXSwitch", "numModifyingFX"]);

// The effect keys present (dropShadow, frameFX, outerGlow, ..., *Multi lists).
function effectKeys(le) {
  if (!isObj(le)) return [];
  return Object.keys(le).filter((k) => !META.has(k) && (isObj(le[k]) || Array.isArray(le[k])));
}
const hasEffects = (le) => effectKeys(le).length > 0;

// An effect entry that is on: not flagged enabled:false or present:false.
const isOn = (e) => isObj(e) && e.enabled !== false && e.present !== false;

// The effect keys that are present and enabled. Photoshop (28.0) returns
// every effect key with enabled:false on the unused ones; a *Multi list
// counts when at least one entry is on.
function activeEffectKeys(le) {
  return effectKeys(le).filter((k) => (Array.isArray(le[k]) ? le[k].some(isOn) : isOn(le[k])));
}

// existing layerEffects (or null) with `key` replaced by effect (removed when
// effect is null); every other effect and the scale are kept. The `<key>Multi`
// list (several shadows, PS 2021+) is dropped with it, so one shadow remains.
function mergeEffects(existing, key, effect) {
  const out = { _obj: "layerEffects" };
  if (isObj(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (k !== key && k !== `${key}Multi` && k !== "_obj") out[k] = clone(v);
    }
  }
  if (effect) out[key] = clone(effect);
  return out;
}

// Effects scale in percent: 100 * ppi / 72 (as Photoshop records it).
const effectsScale = (ppi) => (100 * (isNum(ppi) && ppi > 0 ? ppi : 72)) / 72;

// ---------- drop shadow params ----------

// Our blend names -> Photoshop blendMode enum values.
const BLEND_MODES = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  color_burn: "colorBurn",
  linear_burn: "linearBurn",
  color_dodge: "colorDodge",
  linear_dodge: "linearDodge",
  soft_light: "softLight",
  hard_light: "hardLight",
};
const BLEND_NAMES = Object.fromEntries(Object.entries(BLEND_MODES).map(([k, v]) => [v, k]));

const SHADOW_DEFAULTS = {
  color: { r: 0, g: 0, b: 0 },
  opacity: 35,
  angle: 120,
  distance_px: 6,
  spread_pct: 0,
  size_px: 10,
  blend: "multiply",
};
const RANGES = {
  opacity: [0, 100],
  angle: [-180, 180],
  distance_px: [0, 30000],
  spread_pct: [0, 100],
  size_px: [0, 250],
};

// Throws INVALID_ARGS unless params only holds known drop-shadow keys with
// values in range.
function validateShadowParams(params) {
  if (!isObj(params)) throw invalid("params must be an object");
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (k === "color") {
      if (!isObj(v) || !["r", "g", "b"].every((c) => Number.isInteger(v[c]) && v[c] >= 0 && v[c] <= 255)) {
        throw invalid("params.color must be {r, g, b} integers 0..255");
      }
    } else if (k === "blend") {
      if (!Object.prototype.hasOwnProperty.call(BLEND_MODES, v)) {
        throw invalid(`params.blend must be one of ${Object.keys(BLEND_MODES).join(", ")}, got ${v}`);
      }
    } else if (RANGES[k]) {
      const [lo, hi] = RANGES[k];
      if (!isNum(v) || v < lo || v > hi) throw invalid(`params.${k} must be ${lo}..${hi}, got ${v}`);
    } else {
      throw invalid(`unknown drop_shadow param ${k}; use color, opacity, angle, distance_px, spread_pct, size_px, blend`);
    }
  }
  return params;
}

const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

// Full params: base (defaults, or the current values) with the given ones over it.
const shadowParams = (params, base = SHADOW_DEFAULTS) => ({ ...base, ...defined(params) });

const val = (v) => (isObj(v) && "_value" in v ? v._value : v);
const numOr = (v, dflt) => (isNum(val(v)) ? val(v) : dflt);

// The params of an existing dropShadow descriptor (from a `get`). color is
// null when it is not RGB (it is then left as it is unless a colour is given);
// blend is our name, or Photoshop's own value for a mode we do not list.
function shadowFromDescriptor(ds) {
  const c = isObj(ds && ds.color) ? ds.color : null;
  const rgb = c && c._obj === "RGBColor" ? { r: Math.round(c.red), g: Math.round(c.grain), b: Math.round(c.blue) } : null;
  const mode = val(ds && ds.mode);
  return {
    color: rgb,
    opacity: numOr(ds && ds.opacity, SHADOW_DEFAULTS.opacity),
    angle: numOr(ds && ds.localLightingAngle, SHADOW_DEFAULTS.angle),
    distance_px: numOr(ds && ds.distance, SHADOW_DEFAULTS.distance_px),
    spread_pct: numOr(ds && ds.chokeMatte, SHADOW_DEFAULTS.spread_pct),
    size_px: numOr(ds && ds.blur, SHADOW_DEFAULTS.size_px),
    blend: typeof mode === "string" ? BLEND_NAMES[mode] || mode : SHADOW_DEFAULTS.blend,
  };
}

// Flat numbers for applyParams along drop_shadow.js's fields.
function flatShadow(full, scale) {
  const out = {
    scale,
    opacity: full.opacity,
    angle: full.angle,
    distance_px: full.distance_px,
    spread_pct: full.spread_pct,
    size_px: full.size_px,
  };
  if (full.color) Object.assign(out, { color_r: full.color.r, color_g: full.color.g, color_b: full.color.b });
  return out;
}

const blendValue = (blend) => BLEND_MODES[blend] || blend;

module.exports = {
  effectKeys, hasEffects, activeEffectKeys, mergeEffects, effectsScale,
  BLEND_MODES, SHADOW_DEFAULTS, validateShadowParams, shadowParams, shadowFromDescriptor, flatShadow, blendValue,
};
