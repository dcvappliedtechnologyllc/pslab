// Design actions: shapes and layer styles. Validation runs before any modal
// call, so a rejected call leaves no history state; each change is one named
// step (stepIn).
const D = require("../descriptors");
const { bp } = require("../step");
const { findLayer, resolveDoc, safe, layerBounds } = require("../doc");
const { lineRect } = require("../layout");
const { codedError, stepIn, applyParams } = require("./edit");
const { requireAnchor, selectAnchor } = require("../place");
const defaultRecorded = require("../recorded/index");

// Test hook: replace the recorded-descriptor map (null restores the files).
let recordedOverride = null;
function setRecorded(map) {
  recordedOverride = map;
}
const recordedMap = () => recordedOverride || defaultRecorded;
const usable = (rec) => !!rec && !rec.unsupported;

const invalid = (message) => codedError("INVALID_ARGS", message);
const given = (v) => v !== undefined && v !== null;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const pct = (v) => ({ _unit: "percentUnit", _value: v });

// ---------- argument checks ----------

function requireColor(c, key = "color") {
  if (!isObj(c)) throw invalid(`${key} must be {r, g, b}`);
  for (const k of ["r", "g", "b"]) {
    if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 255) throw invalid(`${key}.${k} must be an integer 0..255, got ${c[k]}`);
  }
  return { r: c.r, g: c.g, b: c.b };
}

function requireBox(b, key = "bbox") {
  if (!isObj(b) || !["left", "top", "right", "bottom"].every((k) => isNum(b[k]))) {
    throw invalid(`${key} must be {left, top, right, bottom} in image pixels`);
  }
  if (!(b.left < b.right && b.top < b.bottom)) throw invalid(`${key} needs left < right and top < bottom`);
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
}

function requirePoint(p, key) {
  if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) throw invalid(`${key} must be {x, y} in image pixels`);
  return { x: p.x, y: p.y };
}

function requirePct(v, key) {
  if (!given(v)) return undefined;
  if (!isNum(v) || v < 0 || v > 100) throw invalid(`${key} must be 0..100, got ${v}`);
  return v;
}

const activeId = (d) => {
  const layer = Array.from(safe(() => d.activeLayers, null) || [])[0];
  return layer ? layer.id : null;
};

// ---------- add_shape ----------

const SHAPES = ["rect", "ellipse", "line"];

// {bbox, angle, corners}: rect/ellipse from bbox, line from from/to/thickness_px.
function shapeGeometry(args) {
  if (args.kind !== "line") return { bbox: requireBox(args.bbox), angle: 0, corners: null };
  const from = requirePoint(args.from, "from");
  const to = requirePoint(args.to, "to");
  const t = args.thickness_px;
  if (!isNum(t) || t <= 0) throw invalid("a line needs thickness_px > 0");
  if (from.x === to.x && from.y === to.y) throw invalid("a line needs from and to to differ (zero length)");
  return lineRect(from, to, t);
}

// Edit > Fill with a colour into the active selection.
const fillColor = (c) => ({
  _obj: "fill",
  using: { _enum: "fillContents", _value: "color" },
  color: { _obj: "RGBColor", red: c.r, grain: c.g, blue: c.b },
  opacity: pct(100),
  mode: { _enum: "blendMode", _value: "normal" },
});

const selectEllipse = (b) => ({
  _obj: "set",
  _target: [{ _ref: "channel", _property: "selection" }],
  to: { _obj: "ellipse", top: px(b.top), left: px(b.left), bottom: px(b.bottom), right: px(b.right) },
  antiAlias: true,
});

// The vector shape layer from the (draft) recorded make; null when there is no
// usable descriptor or Photoshop refuses it (then the raster path runs).
async function tryVectorShape(ps, d, rec, geo, color) {
  if (!usable(rec)) return null;
  const before = activeId(d);
  try {
    const { left, top, right, bottom } = geo.bbox;
    await bp(ps, applyParams(rec, { left, top, right, bottom, color_r: color.r, color_g: color.g, color_b: color.b }));
  } catch {
    return null;
  }
  const id = activeId(d);
  return id !== null && id !== before ? id : null;
}

// Raster fallback: a new pixel layer, a selection of the shape, filled with the
// colour, then deselected. A rotated line is a polygon selection (no resampling).
async function rasterShape(ps, d, kind, geo, color, name) {
  await bp(ps, [{ _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer", name } }]);
  const id = activeId(d);
  if (id === null) throw codedError("NO_NEW_LAYER", "The new layer was not found after creating it");
  let select;
  if (kind === "ellipse") select = selectEllipse(geo.bbox);
  else if (kind === "line" && geo.angle !== 0) select = { ...D.selectPolygon(geo.corners), antiAlias: true };
  else select = D.selectRectangle(geo.bbox);
  await bp(ps, [select, fillColor(color), D.deselect()]);
  return id;
}

async function add_shape(ps, args = {}) {
  const kind = args.kind;
  if (!SHAPES.includes(kind)) throw invalid(`kind must be rect, ellipse or line, got ${kind}`);
  const geo = shapeGeometry(args);
  const color = requireColor(args.color);
  const name = args.name;
  if (typeof name !== "string" || name.length === 0) throw invalid("name must be a non-empty string");
  const opacity = requirePct(args.opacity, "opacity");
  const { d } = resolveDoc(ps, args.doc);
  const hasAbove = given(args.above);
  if (hasAbove) requireAnchor(d, args.above);
  const rec = recordedMap()[kind === "ellipse" ? "shape_ellipse" : "shape_rect"];
  return stepIn(ps, `Claude: add_shape, ${kind} ${name}`, d, async () => {
    // a make lands directly above the selected layer
    if (hasAbove) await selectAnchor(ps, args.above);
    let id = await tryVectorShape(ps, d, rec, geo, color);
    const vector = id !== null;
    if (vector) {
      if (geo.angle !== 0) await bp(ps, [D.selectLayerById(id), D.transform({ scalePct: 100, angleDeg: geo.angle })]);
    } else {
      id = await rasterShape(ps, d, kind, geo, color, name);
    }
    const layer = findLayer(d, id);
    if (layer) {
      layer.name = name;
      if (opacity !== undefined) layer.opacity = opacity;
      // made above a clipped layer, the new one joins the clip: release it
      if (hasAbove && safe(() => layer.isClippingMask, false) === true) layer.isClippingMask = false;
    }
    return { layer_id: id, kind, vector, bounds: layer ? layerBounds(layer) : null };
  });
}

module.exports = { add_shape, setRecorded };
