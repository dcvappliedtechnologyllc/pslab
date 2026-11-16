// Pure layout math for move_layer, align_layers and transform_layer. Boxes are
// {left, top, right, bottom} in image pixels; null means an empty layer.

function unionBounds(boxes) {
  const live = boxes.filter(Boolean);
  if (live.length === 0) return null;
  return {
    left: Math.min(...live.map((b) => b.left)),
    top: Math.min(...live.map((b) => b.top)),
    right: Math.max(...live.map((b) => b.right)),
    bottom: Math.max(...live.map((b) => b.bottom)),
  };
}

const has = (v) => typeof v === "number" && Number.isFinite(v);
// Whole pixels: a fractional translate resamples (blurs) pixel layers. +0 drops -0.
const whole = (v) => Math.round(v) + 0;

// The {dx, dy} a move applies. Relative: dx/dy (missing = 0). Absolute: the
// union's top-left goes to (x, y); a missing axis does not move.
function moveDelta(union, { dx, dy, x, y } = {}) {
  if (has(x) || has(y)) {
    return { dx: has(x) ? whole(x - union.left) : 0, dy: has(y) ? whole(y - union.top) : 0 };
  }
  return { dx: has(dx) ? whole(dx) : 0, dy: has(dy) ? whole(dy) : 0 };
}

const centre = (b) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });

// transform_layer: the offset that moves the bounds centre to (cx, cy) (a
// missing axis keeps it). Under QCSAverage Photoshop scales and rotates about
// that centre, then applies the offset.
function transformDelta(bounds, { cx, cy } = {}) {
  const c = centre(bounds);
  const tx = has(cx) ? cx : c.x;
  const ty = has(cy) ? cy : c.y;
  return { dx: tx - c.x + 0, dy: ty - c.y + 0, cx: tx, cy: ty };
}

// One axis: the shift that aligns [b0, b1] to [t0, t1] at start, center or end.
function axisDelta(b0, b1, t0, t1, at) {
  if (at === "start") return whole(t0 - b0);
  if (at === "end") return whole(t1 - b1);
  if (at === "center") return whole((t0 + t1) / 2 - (b0 + b1) / 2);
  return 0;
}
const H = { left: "start", center: "center", right: "end" };
const V = { top: "start", center: "center", bottom: "end" };

// align_layers: one {dx, dy} per box. asGroup aligns the union of the boxes
// and gives every box the same delta (keeps a title + bars block intact).
function alignDeltas(boxes, target, { horizontal, vertical } = {}, asGroup = false) {
  const delta = (b) => ({
    dx: axisDelta(b.left, b.right, target.left, target.right, H[horizontal]),
    dy: axisDelta(b.top, b.bottom, target.top, target.bottom, V[vertical]),
  });
  if (boxes.length === 0) return [];
  if (asGroup) {
    const one = delta(unionBounds(boxes));
    return boxes.map(() => ({ ...one }));
  }
  return boxes.map(delta);
}

// ---------- add_shape lines (B4) ----------

// A line from `from` to `to`, thickness t, as a rectangle: bbox is the
// unrotated length x t box centred on the midpoint, angle the clockwise
// rotation (degrees, -90..90; image y grows down) that lays it on the line,
// and corners the rotated box (top-left, top-right, bottom-right, bottom-left
// of the unrotated box) for a polygon selection. Vertical lines come back as
// an upright t x length box with angle 0, so they need no rotation.
function lineRect(from, to, t) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) throw new Error("A line needs two different points (zero length)");
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  if (dx === 0) {
    const bbox = { left: mx - t / 2, top: my - len / 2, right: mx + t / 2, bottom: my + len / 2 };
    return { bbox, angle: 0, corners: boxCorners(bbox) };
  }
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle <= -90) angle += 180;
  angle += 0;
  const bbox = { left: mx - len / 2, top: my - t / 2, right: mx + len / 2, bottom: my + t / 2 };
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = boxCorners(bbox).map(({ x, y }) =>
    angle === 0
      ? { x, y }
      : { x: mx + (x - mx) * cos - (y - my) * sin, y: my + (x - mx) * sin + (y - my) * cos },
  );
  return { bbox, angle, corners };
}

const boxCorners = (b) => [
  { x: b.left, y: b.top },
  { x: b.right, y: b.top },
  { x: b.right, y: b.bottom },
  { x: b.left, y: b.bottom },
];

// ---------- content_aware_fill sample (B3) ----------
// Trees are DOM-like: {id, visible, isClippingMask?, layers?}, top of the stack first.

const read = (fn, fallback) => {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
};
const kidsOf = (layer) => Array.from(read(() => layer.layers, null) || []);
const isVisible = (layer) => read(() => layer.visible, true) !== false;

function flattenTree(layers, out = []) {
  for (const layer of Array.from(layers || [])) {
    out.push(layer);
    flattenTree(kidsOf(layer), out);
  }
  return out;
}

// Ids of the anchor and every layer painted under it (later in a top-first
// pre-order walk); [] for an unknown anchor.
function belowIds(layers, anchorId) {
  const flat = flattenTree(layers);
  const i = flat.findIndex((l) => l.id === anchorId);
  return i === -1 ? [] : flat.slice(i).map((l) => l.id);
}

// Ids to hide so only the kept layers show: every visible layer that is not
// kept and holds nothing kept. Groups holding a kept layer stay visible (their
// other children are hidden one by one); a kept group keeps its contents; a
// kept clipped layer keeps its clipping base (the next unclipped sibling
// below), or it would show nothing. Hidden layers are left alone, so turning
// the returned ids back on restores the document exactly.
function hidePlan(layers, keepIds) {
  const keep = new Set(keepIds);
  const addBases = (list) => {
    list.forEach((layer, i) => {
      if (keep.has(layer.id) && read(() => layer.isClippingMask, false) === true) {
        const base = list.slice(i + 1).find((l) => read(() => l.isClippingMask, false) !== true);
        if (base) keep.add(base.id);
      }
      addBases(kidsOf(layer));
    });
  };
  addBases(Array.from(layers || []));
  const holdsKept = (layer) => keep.has(layer.id) || kidsOf(layer).some(holdsKept);
  const hide = [];
  const walk = (list) => {
    for (const layer of list) {
      if (keep.has(layer.id)) continue;
      if (kidsOf(layer).some(holdsKept)) walk(kidsOf(layer));
      else if (isVisible(layer)) hide.push(layer.id);
    }
  };
  walk(Array.from(layers || []));
  return hide;
}

// Non-group layers that still show once hideIds are hidden.
function visibleLeaves(layers, hideIds) {
  const hidden = new Set(hideIds);
  const out = [];
  const walk = (list) => {
    for (const layer of list) {
      if (hidden.has(layer.id) || !isVisible(layer)) continue;
      const kids = read(() => layer.layers, null);
      if (kids) walk(Array.from(kids));
      else out.push(layer);
    }
  };
  walk(Array.from(layers || []));
  return out;
}

module.exports = {
  unionBounds, moveDelta, transformDelta, alignDeltas, centre, whole,
  belowIds, hidePlan, visibleLeaves, flattenTree, lineRect,
};
