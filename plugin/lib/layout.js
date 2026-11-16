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

module.exports = { unionBounds, moveDelta, transformDelta, centre, whole };
