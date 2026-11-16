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

module.exports = { unionBounds, moveDelta, transformDelta, alignDeltas, centre, whole };
