// Geometry and cleanup actions: straighten, content-aware fill, clone.
// Non-destructive: the Background is never transformed or erased; every
// result is a NEW layer above it. Validation happens before runStep so a
// rejected call never creates a history state.
const D = require("../descriptors");
const { runStep, runRead, bp } = require("../step");
const { findLayer, resolveDoc } = require("../doc");
const { estimateTilt, toGray, round1 } = require("../geometry");

function codedError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const invalidArgs = (message) => codedError("INVALID_ARGS", message);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function activate(ps, d) {
  const active = ps.app.activeDocument;
  if (!active || active.id !== d.id) ps.app.activeDocument = d;
}

function restore(ps, original) {
  try {
    if (original) activate(ps, original);
  } catch {
    // the original document may have been closed meanwhile
  }
}

// One history step in d; the document active before the call is active again
// afterwards, on success and on failure.
function stepIn(ps, name, d, fn) {
  const original = ps.app.activeDocument;
  return runStep(ps, name, d.id, async () => {
    try {
      activate(ps, d);
      return await fn();
    } finally {
      restore(ps, original);
    }
  });
}

const activeId = (d) => {
  const layer = Array.from(d.activeLayers || [])[0];
  if (!layer) throw codedError("NO_NEW_LAYER", "The new layer was not found after creating it");
  return layer.id;
};

// A bounds edge may be a number or a unit value ({_value} or {value}).
function edge(v) {
  if (v !== null && typeof v === "object") v = "_value" in v ? v._value : v.value;
  return Number(v);
}

function norm(b) {
  if (!b) return null;
  return { left: edge(b.left), top: edge(b.top), right: edge(b.right), bottom: edge(b.bottom) };
}

const canvas = (d) => ({ w: Number(d.width), h: Number(d.height) });

function safe(read, fallback) {
  try {
    const v = read();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Every layer of the tree, top of the stack first.
function flatten(layers, out = []) {
  for (const layer of Array.from(layers || [])) {
    out.push(layer);
    flatten(safe(() => layer.layers, null), out);
  }
  return out;
}

// ---------- straighten ----------

// The Background layer, or the bottom layer when the document has none.
function baseLayer(d) {
  const layers = Array.from(d.layers || []);
  const bg = layers.find((l) => {
    try {
      return l.isBackgroundLayer === true;
    } catch {
      return false;
    }
  });
  const base = bg || layers[layers.length - 1];
  if (!base) throw codedError("NO_LAYER", "The document has no layers");
  return base;
}

const STRAIGHTENED = "Straightened";
const PREVIEW_PX = 768;
const MIN_CONFIDENCE = 0.05;
const MIN_EDGES = 50;

// Downscaled composite -> luminance -> tilt estimate. Read-only (no history).
async function measureTilt(ps, d, vertical) {
  const { w, h } = canvas(d);
  const targetSize = w >= h ? { width: Math.min(PREVIEW_PX, w) } : { height: Math.min(PREVIEW_PX, h) };
  return runRead(ps, "Straighten Measure", async () => {
    const { imageData } = await ps.imaging.getPixels({
      documentID: d.id,
      sourceBounds: { left: 0, top: 0, right: w, bottom: h },
      targetSize,
      componentSize: 8,
      applyAlpha: true,
      // Grayscale, CMYK or Lab documents would otherwise come back in their own
      // mode (1 or 4 components that are not RGB).
      colorSpace: "RGB",
    });
    try {
      const data = await imageData.getData({ chunky: true });
      const gray = toGray(data, imageData.width, imageData.height, imageData.components);
      return { ...estimateTilt(gray, imageData.width, imageData.height, { vertical }), preview_width: imageData.width };
    } finally {
      imageData.dispose();
    }
  });
}

async function straighten(ps, args = {}) {
  const hasAngle = args.angle_deg !== undefined && args.angle_deg !== null;
  const auto = args.auto === true;
  if (hasAngle === auto) throw invalidArgs("Give exactly one of angle_deg or auto: true");
  if (hasAngle && (!isNum(args.angle_deg) || args.angle_deg < -45 || args.angle_deg > 45)) {
    throw invalidArgs("angle_deg must be a number from -45 to 45");
  }
  const vertical = args.vertical !== false;
  const { d } = resolveDoc(ps, args.doc);
  const base = baseLayer(d);
  // The new copy is placed directly above the base, so a second one would land
  // UNDER the first and change nothing visible. A hidden one no longer covers it.
  const isOld = (l) => safe(() => l.name, "") === STRAIGHTENED && safe(() => l.visible, true) !== false;
  if (flatten(d.layers).some(isOld)) {
    throw codedError(
      "ALREADY_STRAIGHTENED",
      `The document already has a "${STRAIGHTENED}" layer; a second copy would land under it. ` +
        "Delete it with delete_layer (confirm: true) or hide it first, then straighten again.",
    );
  }

  let angle = hasAngle ? args.angle_deg : 0;
  let measured;
  if (auto) {
    const m = await measureTilt(ps, d, vertical);
    measured = { angle_deg: m.angle_deg, confidence: m.confidence, edges_used: m.edges_used, preview_width: m.preview_width };
    if (m.confidence < MIN_CONFIDENCE || m.edges_used < MIN_EDGES) {
      throw codedError(
        "NO_EDGES",
        `Not enough straight ${vertical ? "vertical" : "horizontal"} edges to measure a tilt ` +
          `(edges_used ${m.edges_used}, confidence ${m.confidence}); give angle_deg instead`,
      );
    }
    angle = round1(m.angle_deg);
  }

  // Camera Raw's Upright/geometry has no known descriptor, so this is a Free
  // Transform rotation of a smart-object copy (re-editable, lossless to redo).
  return stepIn(ps, `Claude: straighten, ${angle}°`, d, async () => {
    const dup = await base.duplicate();
    dup.name = STRAIGHTENED;
    await bp(ps, [D.selectLayerById(dup.id), D.newPlacedLayer()]);
    const id = activeId(d); // converting to a smart object can change the id
    await bp(ps, [D.transform({ scalePct: 100, angleDeg: angle })]);
    const result = { layer_id: id, angle_deg: angle, method: "free_transform" };
    if (measured) result.measured = measured;
    return result;
  });
}

// ---------- shared by content_aware_fill and clone_from ----------

// A {left, top, right, bottom} box with left < right, top < bottom, inside the canvas.
function bboxInside(b, w, h) {
  return !!b && ["left", "top", "right", "bottom"].every((k) => isNum(b[k])) &&
    b.left >= 0 && b.top >= 0 && b.right <= w && b.bottom <= h && b.left < b.right && b.top < b.bottom;
}

const bboxText = (b) => `{left ${b.left}, top ${b.top}, right ${b.right}, bottom ${b.bottom}}`;

function requireName(name) {
  if (typeof name !== "string" || name.length === 0) throw invalidArgs("name is required (a non-empty string)");
}

// Stamp Visible with the top layer selected, so the composite lands on top of
// the stack as a new pixel layer; renamed to `name`. Returns the layer.
async function stampOnTop(ps, d, name) {
  const top = Array.from(d.layers || [])[0];
  if (!top) throw codedError("NO_LAYER", "The document has no layers");
  let layer;
  if (flatten(d.layers).length === 1) {
    // Stamp Visible is unavailable when the document has a single layer (a
    // lone Background, say); a copy of that layer is the same composite.
    layer = await top.duplicate();
    if (layer) await bp(ps, [D.selectLayerById(layer.id)]);
  } else {
    await bp(ps, [D.selectLayerById(top.id), D.stampVisible()]);
    layer = findLayer(d, activeId(d));
  }
  if (!layer || layer.id === top.id) throw codedError("NO_NEW_LAYER", "Stamp Visible did not make a new layer");
  layer.name = name;
  // Stamped above a clipped top layer, the new layer joins its clipping group
  // and would only show where the layer below has pixels: release it.
  if (safe(() => layer.isClippingMask, false) === true) layer.isClippingMask = false;
  return layer;
}

// ---------- content_aware_fill ----------

const APRON_PX = 2;

async function content_aware_fill(ps, args = {}) {
  const hasBbox = args.bbox !== undefined && args.bbox !== null;
  const hasPolygon = args.polygon !== undefined && args.polygon !== null;
  if (hasBbox === hasPolygon) throw invalidArgs("Give exactly one of bbox or polygon");
  requireName(args.name);
  const { d } = resolveDoc(ps, args.doc);
  const { w, h } = canvas(d);
  if (hasBbox && !bboxInside(args.bbox, w, h)) {
    throw invalidArgs(`bbox must have left < right, top < bottom and lie inside the ${w}x${h} canvas`);
  }
  if (hasPolygon) {
    const pts = args.polygon;
    const ok = Array.isArray(pts) && pts.length >= 3 &&
      pts.every((p) => p && isNum(p.x) && isNum(p.y) && p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h);
    if (!ok) throw invalidArgs(`polygon needs at least 3 points {x, y} inside the ${w}x${h} canvas`);
  }

  return stepIn(ps, `Claude: content_aware_fill, ${args.name}`, d, async () => {
    const layer = await stampOnTop(ps, d, args.name);
    // Fill the region (plus a 2 px apron so the patch blends at its edge) on
    // the stamped copy, then erase everything else so only the patch remains.
    await bp(ps, [
      hasBbox ? D.selectRectangle(args.bbox) : D.selectPolygon(args.polygon),
      D.expand(APRON_PX),
      D.contentAwareFill(),
      D.inverseSelection(),
      D.clearSelected(),
      D.deselect(),
    ]);
    const after = findLayer(d, layer.id) || layer;
    return { layer_id: layer.id, bounds: norm(after.bounds) };
  });
}

// ---------- clone_from ----------

const MAX_FEATHER_PX = 200;

async function clone_from(ps, args = {}) {
  requireName(args.name);
  const f = args.feather_px === undefined || args.feather_px === null ? 0 : args.feather_px;
  if (!isNum(f) || f < 0 || f > MAX_FEATHER_PX) throw invalidArgs(`feather_px must be a number from 0 to ${MAX_FEATHER_PX}`);
  const { d } = resolveDoc(ps, args.doc);
  const { w, h } = canvas(d);
  const src = args.src_bbox;
  if (!bboxInside(src, w, h)) {
    throw invalidArgs(`src_bbox must have left < right, top < bottom and lie inside the ${w}x${h} canvas`);
  }
  const dst = args.dst;
  if (!dst || !isNum(dst.x) || !isNum(dst.y) || dst.x < 0 || dst.y < 0 || dst.x >= w || dst.y >= h) {
    throw invalidArgs(`dst must be {x, y} inside the ${w}x${h} canvas`);
  }
  // contract + feather of f each side: a box narrower than 2f would leave an empty mask.
  if (f > 0 && 2 * f >= Math.min(src.right - src.left, src.bottom - src.top)) {
    throw invalidArgs(`feather_px ${f} is too large for src_bbox ${bboxText(src)}: keep it under half its shorter side`);
  }
  const dx = dst.x - src.left;
  const dy = dst.y - src.top;

  return stepIn(ps, `Claude: clone_from, ${args.name}`, d, async () => {
    const layer = await stampOnTop(ps, d, args.name);
    // Keep only src_bbox of the stamped composite, then move it so its
    // top-left corner lands on dst.
    await bp(ps, [D.selectRectangle(src), D.inverseSelection(), D.clearSelected(), D.deselect()]);
    await bp(ps, [D.selectLayerById(layer.id), D.transform({ scalePct: 100, dx, dy })]);
    if (f > 0) {
      // A soft-edged mask: the moved box shrunk by f then feathered by f, so
      // the edge fades out inside the copy instead of past its hard border.
      const moved = { left: src.left + dx, top: src.top + dy, right: src.right + dx, bottom: src.bottom + dy };
      await bp(ps, [
        D.selectRectangle(moved),
        D.contract(f),
        D.feather(f),
        D.makeMaskFromSelection("reveal"),
        D.deselect(),
      ]);
    }
    const after = findLayer(d, layer.id) || layer;
    return { layer_id: layer.id, bounds: norm(after.bounds), feather_px: f };
  });
}

module.exports = { straighten, content_aware_fill, clone_from };
